import { fail } from './runtime.mjs'
import { readPodInventory, podConnection } from './pod-inventory.mjs'
import { readCompactWhoami } from './pod-relations.mjs'
import { readNativeJson } from './native-read.mjs'
import { projectUserResolutions, validRequestSource } from './user-report-projection.mjs'
const listRequests = (endpoint, source, destination, signal) => readNativeJson(endpoint, '/api/queue/list', { sourceSession: source, destinationSession: destination, compact: '1', sort: 'updated', limit: '20' }, signal, 1048576)
/**
 * @param {{ execute?: typeof import('./runtime.mjs').run, readIdentity?: typeof readCompactWhoami, readRequests?: typeof listRequests, signal?: AbortSignal, base?: NodeJS.ProcessEnv }} options
 * @returns {Promise<import('./protocol').UserReports>}
 */
export async function readUserReports(config, snapshot, input, options = {}) {
  const { execute, readIdentity = readCompactWhoami, readRequests = listRequests, signal, base = process.env } = options
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 4 || new Set(input.sources).size !== input.sources.length || input.sources.some(s => !validRequestSource(s))) throw fail('invalid_source_filter', 'Choose 1–4 exact declared external request sources (name@external).')
  const catalog = await readPodInventory(config, snapshot, input.source, execute, base)
  if (catalog.connection.key !== input.instanceKey) throw fail('instance_changed', 'The observed instance changed. Refresh before reading user reports.')
  const pod = catalog.pods.find(p => p.key === input.podKey), seat = catalog.seats.find(s => s.key === input.seatKey && s.rigId === pod?.rigId)
  if (!pod || !seat) throw fail('report_seat_changed', 'Choose a currently registered reporting seat in the selected rig.')
  const context = { instanceKey: input.instanceKey, podKey: pod.key, seatKey: seat.key, rigId: pod.rigId, reportingSeat: `${seat.rigName} / ${seat.logicalId}`, sources: [...input.sources], observedAt: Date.now() }
  const notes = ['These are original resolutions stored on requests assigned to the selected seat, not an LLM summary or verified authorship; another actor or an earlier seat occupant may have written them.', 'External source labels are declared claims, not authenticated human identities. A recorded done state does not prove independent correctness or delivery to the user.']
  if (!seat.session) return { ...context, status: 'unverified', reports: [], notes: [...notes, 'No canonical session exists. No report source or session was invented.'], truncated: false }
  let own
  try { own = await readIdentity(catalog.connection.endpoint, seat.session, signal) } catch { return { ...context, status: 'unverified', reports: [], notes: [...notes, 'The reporting seat identity is unavailable. No terminal/transcript fallback was used.'], truncated: false } }
  if (own?.partial || own?.daemonReachable === false || own?.runtimeContext != null || own?.identity?.rigId !== seat.rigId || own?.identity?.logicalId !== seat.logicalId || own?.identity?.podId !== seat.podId) throw fail('report_seat_changed', 'The native reporting-seat identity does not match the selected seat.')
  const destinations = [seat.session, own.identity.senderAddress].filter(s => typeof s === 'string' && s.length > 0 && s.length <= 200)
  const rows = []; let failures = 0, fullWindow = false
  for (const source of input.sources) {
    if (signal?.aborted) throw fail('cancelled', 'User report read cancelled')
    try {
      const items = await readRequests(catalog.connection.endpoint, source, seat.session, signal)
      if (!Array.isArray(items) || items.length > 20) throw new Error('Invalid source window')
      fullWindow ||= items.length === 20; rows.push(...items)
    } catch { failures++ }
  }
  if ((await podConnection(config, input.source, base)).key !== input.instanceKey) throw fail('instance_changed', 'The instance changed during the report read. Refresh first.')
  const projected = projectUserResolutions(rows, { sources: input.sources, destinations })
  const truncated = fullWindow || projected.incomplete
  if (truncated) notes.push('Only the latest 20 requests per declared source and at most 10 report cards are inspected. Older or unmatched records may exist.')
  if (failures) notes.push('Some request-source reads failed. Missing cards are unverified, not evidence that no report exists.')
  if (!projected.reports.length) notes.push('No stored resolution was found in the inspected request windows. No report was generated or requested from an agent.')
  notes.push('Bodies are shown as plain text up to 16 KiB each; referenced task IDs, commands and file paths are evidence text only and are never followed or executed.')
  return { ...context, status: failures === input.sources.length ? 'unverified' : failures || projected.incomplete ? 'partial' : 'ready', reports: projected.reports, notes, truncated }
}
