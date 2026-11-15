import { fail } from './runtime.mjs'
import { readPodInventory, podConnection } from './pod-inventory.mjs'
import { seatInPod } from './pods.mjs'
import { readCompactWhoami } from './pod-relations.mjs'
import { readNativeJson } from './native-read.mjs'
import { reportPrefix } from './report-preview.mjs'

const WINDOW = 20
const address = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
const automatic = tags => Array.isArray(tags) && tags.some(tag => typeof tag === 'string' && (tag === 'seat-skill-list' || /^queue:(?:auto-unpark|wake-trigger):/.test(tag)))
const identityMatches = (data, seat) => data && !data.partial && data.daemonReachable !== false && data.runtimeContext == null && data.identity?.rigId === seat.rigId && data.identity?.logicalId === seat.logicalId && data.identity?.podId === seat.podId
const outbox = (endpoint, session, signal) => readNativeJson(endpoint, '/api/queue/outbox/list', { senderSession: session, limit: WINDOW }, signal, 1048576)

/**
 * @param {{ execute?: typeof import('./runtime.mjs').run, readIdentity?: typeof readCompactWhoami, readOutbox?: typeof outbox, signal?: AbortSignal, base?: NodeJS.ProcessEnv }} options
 * @returns {Promise<import('./protocol').ReportPreview>}
 */
export async function readSeatReport(config, snapshot, input, options = {}) {
  const { execute, readIdentity = readCompactWhoami, readOutbox = outbox, signal, base = process.env } = options
  const catalog = await readPodInventory(config, snapshot, input.source, execute, base)
  if (catalog.connection.key !== input.instanceKey) throw fail('instance_changed', 'Refresh the observed instance before reading a report preview.')
  const pod = catalog.pods.find(p => p.key === input.podKey), seat = catalog.seats.find(s => s.key === input.seatKey && seatInPod(s, pod))
  if (!seat) throw fail('pod_changed', 'The hovered seat is no longer in this native pod.')
  const context = { instanceKey: input.instanceKey, podKey: pod.key, seatKey: seat.key, observedAt: Date.now() }
  const unavailable = detail => ({ ...context, status: 'unverified', detail })
  if (!seat.session) return unavailable('No canonical session is recorded for this seat; no sender address or report was invented.')
  let own, records
  try {
    own = await readIdentity(catalog.connection.endpoint, seat.session, signal)
    if (!identityMatches(own, seat)) return unavailable('The native sender identity could not be verified against this seat snapshot.')
    records = await readOutbox(catalog.connection.endpoint, seat.session, signal)
    if (!Array.isArray(records) || records.length > WINDOW) return unavailable('The bounded native outbox response is incomplete or invalid.')
  } catch { return unavailable('Native outbox preview unavailable. No transcript or terminal output was used as a substitute.') }
  const senders = new Set([seat.session, own.identity.senderAddress].filter(address))
  const canonical = new Map(catalog.seats.filter(s => s.session).map(s => [s.session, s])), aliases = new Map(), candidates = []
  let uncertain = false, resolutions = 0
  for (const row of records) {
    if (!row || !senders.has(row.senderSession) || !address(row.destinationSession) || typeof row.body !== 'string' || !address(row.outboxId) || typeof row.tsDispatched !== 'string' || !Number.isFinite(Date.parse(row.tsDispatched))) { uncertain = true; continue }
    if (automatic(row.tags) || /@(?:external|system)$/.test(row.destinationSession)) continue
    candidates.push(row)
  }
  candidates.sort((a, b) => Date.parse(b.tsDispatched) - Date.parse(a.tsDispatched)) // Stable for ties: preserve native newest-first row order.
  let selected, recipient
  for (const row of candidates) {
    recipient = canonical.get(row.destinationSession) || aliases.get(row.destinationSession)
    if (!recipient && !aliases.has(row.destinationSession)) {
      if (resolutions >= 4) { uncertain = true; break }
      resolutions++
      try {
        const resolved = await readIdentity(catalog.connection.endpoint, row.destinationSession, signal)
        recipient = catalog.seats.find(s => identityMatches(resolved, s))
        aliases.set(row.destinationSession, recipient || null)
      } catch { aliases.set(row.destinationSession, null) }
    }
    if (!recipient) { uncertain = true; continue }
    if (recipient.key === seat.key) continue
    selected = row; break
  }
  if ((await podConnection(config, input.source, base)).key !== input.instanceKey) throw fail('instance_changed', 'The instance changed while reading the preview; refresh first.')
  if (!selected) return { ...context, status: uncertain || records.length === WINDOW ? 'unverified' : 'none', detail: 'No qualifying outbound seat-to-seat record was found in the latest 20 native outbox entries. This is not proof that a report never existed.' }
  return { ...context, status: 'recorded', ...reportPrefix(selected.body), recordId: selected.outboxId, recordedAt: selected.tsDispatched,
    recipient: `${recipient.rigName} / ${recipient.logicalId}`, delivery: typeof selected.deliveryState === 'string' ? selected.deliveryState.slice(0, 40) : 'unknown',
    kind: `${Array.isArray(selected.tags) && selected.tags.some(t => typeof t === 'string' && t.startsWith('queue:')) ? 'Recorded queue notification' : 'Recorded outbound message'}${uncertain ? ' · newest unverified' : ''}`,
    detail: `${uncertain ? 'Some entries could not be classified; this may not be the latest message. ' : ''}Raw native outbox excerpt from a 20-entry window, not an LLM summary or a classified/authenticated report. It may belong to an earlier occupant; recorded/delivered does not prove recipient acknowledgment or correct work.` }
}
