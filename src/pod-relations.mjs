import { readNativeJson } from './native-read.mjs'
import { fail } from './runtime.mjs'
import { readPodInventory, podConnection } from './pod-inventory.mjs'
import { seatInPod } from './pods.mjs'

export const readCompactWhoami = (endpoint, session, signal) => readNativeJson(endpoint, '/api/whoami', { compact: '1', sessionName: session }, signal)

/**
 * @param {{ execute?: typeof import('./runtime.mjs').run, read?: typeof readCompactWhoami, signal?: AbortSignal, base?: NodeJS.ProcessEnv }} options
 * @returns {Promise<import('./protocol').PodRelations>}
 */
export async function readPodRelations(config, snapshot, input, options = {}) {
  const { execute, read = readCompactWhoami, signal, base = process.env } = options
  const catalog = await readPodInventory(config, snapshot, input.source, execute, base)
  if (catalog.connection.key !== input.instanceKey) throw fail('instance_changed', 'The observed instance changed. Refresh pods before reading relationships.')
  const pod = catalog.pods.find(p => p.key === input.podKey)
  if (!pod) throw fail('pod_changed', 'The selected pod is no longer in native inventory. Refresh pods; no relationships were guessed.')
  const members = catalog.seats.filter(seat => seatInPod(seat, pod))
  if (members.length > 80) throw fail('topology_limit', 'Read relationships for at most 80 seats at a time; no truncated graph was produced.')
  const notes = ['Native compact relationship metadata, not observed messages or proof of work. Reads are bounded snapshots, not an atomic or continuously updated graph.']
  const incidents = new Map(), known = new Map(members.map(s => [s.logicalId, s])), observed = new Map(), outside = new Set()
  let unavailable = 0, partial = false, cursor = 0
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  async function readMember(seat) {
    if (!seat.session) { unavailable++; return }
    try {
      const data = await read(catalog.connection.endpoint, seat.session, signal)
      if (!data || data.partial || data.daemonReachable === false || data.runtimeContext != null || data.identity?.rigId !== pod.rigId || data.identity?.logicalId !== seat.logicalId || data.identity?.podId !== pod.podId) throw new Error('Identity or compact projection changed')
      const outgoing = data.edges?.outgoing, incoming = data.edges?.incoming
      if (!Array.isArray(outgoing) || !Array.isArray(incoming) || outgoing.length + incoming.length > 2048) throw new Error('Incomplete or oversized native relationship metadata')
      const local = new Map(), localOutside = new Set()
      for (const [entries, direction] of [[outgoing, 'outgoing'], [incoming, 'incoming']]) for (const edge of entries) {
        const from = direction === 'outgoing' ? seat.logicalId : edge?.from?.logicalId
        const to = direction === 'outgoing' ? edge?.to?.logicalId : seat.logicalId
        if (!validId(from) || !validId(to) || !validId(edge?.kind) || edge.kind.length > 80) throw new Error('Invalid native relationship')
        const key = JSON.stringify([from, to, edge.kind])
        if (!known.has(from) || !known.has(to)) { localOutside.add(key); continue }
        local.set(key, { fromKey: known.get(from).key, toKey: known.get(to).key, kind: edge.kind })
      }
      if (data.rosterState === 'building') partial = true
      incidents.set(seat.logicalId, new Set(local.keys()))
      for (const [key, edge] of local) observed.set(key, edge)
      for (const key of localOutside) outside.add(key)
    } catch { unavailable++ }
  }
  // At most four read-only requests in flight. Missing sessions are unknown, never invented addresses.
  await Promise.all(Array.from({ length: Math.min(4, members.length) }, async () => {
    while (cursor < members.length) { if (signal?.aborted) throw fail('cancelled', 'Relationship observation cancelled'); await readMember(members[cursor++]) }
  }))
  if ((await podConnection(config, input.source, base)).key !== input.instanceKey) throw fail('instance_changed', 'The observed instance changed during relationship loading. Refresh pods.')
  for (const [key] of observed) {
    const [from, to] = JSON.parse(key)
    if (incidents.has(from) && incidents.has(to) && (!incidents.get(from).has(key) || !incidents.get(to).has(key))) partial = true
  }
  if (unavailable) notes.push(`${unavailable} seat relationship observations were unavailable or had no canonical session. Missing lines are unverified, not proof that no relationship exists.`)
  if (partial) notes.push('Native observations were building or disagreed during the read; refresh for a newer snapshot.')
  if (outside.size) notes.push(`${outside.size} reported relationships reach outside this selected pod and are not drawn. Endpoints are not guessed.`)
  let edges = [...observed.values()]
  if (edges.length > 160) { edges = []; partial = true; notes.push('More than 160 internal relationships were reported; no truncated graph was substituted.') }
  const status = unavailable === members.length ? 'unavailable' : unavailable || partial ? 'partial' : 'complete'
  if (status === 'complete' && !edges.length) notes.push('All selected seats were queried; no same-pod relationships were reported by the native compact API.')
  return { instanceKey: input.instanceKey, podKey: pod.key, memberKeys: members.map(s => s.key), observedAt: Date.now(), status, edges, omittedEdges: outside.size, notes }
}
