// Native pod identity is the database rig/pod pair, never an Orca workspace or a guessed logical-ID prefix.
export const operationInstance = config => JSON.stringify([config.instanceHome || `${config.root}/instance`, config.daemonPort])
export const podKeyOf = seat => seat && typeof seat.rigId === 'string' && seat.rigId.length > 0 && ((typeof seat.podId === 'string' && seat.podId.length > 0) || seat.podId === null) ? JSON.stringify([seat.rigId, seat.podId]) : null
export const seatInPod = (seat, pod) => Boolean(seat && pod && podKeyOf(seat) === pod.key && seat.rigId === pod.rigId && seat.podId === pod.podId)
export function podsFromSeats(seats) {
  const groups = new Map(), identities = new Set()
  if (!Array.isArray(seats) || seats.length > 512) throw new Error('Native pod inventory is unavailable or exceeds 512 seats; narrow it before using this dashboard.')
  for (const seat of seats) {
    const key = podKeyOf(seat)
    if (!key || typeof seat.key !== 'string' || identities.has(seat.key)) throw new Error('Native seat identities are missing or duplicated; no pod target was guessed.')
    identities.add(seat.key)
    if (!groups.has(key)) groups.set(key, { key, rigId: seat.rigId, rigName: seat.rigName, podId: seat.podId,
      namespace: seat.podNamespace || null, label: `${seat.rigName} / ${seat.podNamespace || (seat.podId ? `[namespace unavailable · ${seat.podId}]` : '[unassigned seats]')}`, seatCount: 0 })
    const pod = groups.get(key)
    if (pod.namespace !== (seat.podNamespace || null) || pod.rigName !== seat.rigName) throw new Error('Native pod metadata changed within this snapshot; refresh before selecting a target.')
    pod.seatCount++
  }
  if (groups.size > 128) throw new Error('Native inventory exceeds 128 pods; no truncated pod list was displayed.')
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key))
}
export function topologyForPod(pod, seats, observedAt, relations = null) {
  const members = seats.filter(seat => seatInPod(seat, pod))
  if (members.length > 80) throw new Error('This pod has more than 80 seats. Its complete seat list remains available, but the diagram was not truncated.')
  const nodes = members.map((seat, i) => ({ uid: `agent_${i}`, key: seat.key, podId: pod.key, podNamespace: pod.namespace || pod.label, id: seat.logicalId,
    runtime: seat.runtime, model: seat.model || 'Not declared here', role: 'Not provided by seat inventory', agentRef: 'Not provided by seat inventory',
    status: seat.status, activity: seat.activity, attention: seat.attention }))
  const current = relations?.podKey === pod.key ? relations : null, byKey = new Map(nodes.map(n => [n.key, n.uid])), edges = []
  const warnings = ['Manual native inventory snapshot, not continuous live polling. Running does not mean working or healthy.', ...(current?.notes || ['Relationship edges were not queried yet; no delegation arrows were inferred.'])]
  let missing = 0
  for (const edge of current?.edges || []) {
    const from = byKey.get(edge.fromKey), to = byKey.get(edge.toKey)
    if (!from || !to) { missing++; continue }
    edges.push({ from, to, kind: edge.kind })
  }
  if (edges.length > 160) throw new Error('More than 160 relationships cannot be rendered; no truncated graph was substituted.')
  if (missing) warnings.push(`${missing} relationships no longer match the displayed membership snapshot and were not drawn. Refresh this pod.`)
  return { name: pod.label, source: 'inventory', observedAt, relationsStatus: missing ? 'partial' : current?.status || 'unqueried', relationshipObservedAt: current?.observedAt,
    pods: [{ uid: 'pod_0', id: pod.key, label: pod.namespace || pod.label }], nodes, edges, warnings }
}
