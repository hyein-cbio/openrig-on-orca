import { utf8Excerpt } from './report-preview.mjs'
export const DEFAULT_REQUEST_SOURCES = ['user@external', 'orca-gui@external']
export const validRequestSource = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}@external$/.test(value)
export function requestSources(text) {
  const sources = [...new Set(String(text).split(',').map(s => s.trim()).filter(Boolean))]
  if (!sources.length || sources.length > 4 || sources.some(s => !validRequestSource(s))) throw new Error('Choose 1–4 exact declared external source addresses, separated by commas (name@external).')
  return sources
}
// A default is based on the complete rig's observed delegation graph, never the spelling "lead".
// Other cases require an explicit reporting-seat selection; this is not an authority/permission claim.
export function reportingSeatDefault(inventory, pod, relations, selected = '') {
  if (!inventory || !pod) return ''
  const seats = inventory.seats.filter(s => s.rigId === pod.rigId)
  if (seats.some(s => s.key === selected)) return selected
  if (seats.length === 1) return seats[0].key
  if (seats.some(s => s.podId !== pod.podId) || relations?.podKey !== pod.key || relations.status !== 'complete' || relations.omittedEdges) return ''
  const incoming = new Set(), outgoing = new Set()
  for (const edge of relations.edges) if (edge.kind === 'delegates_to') { outgoing.add(edge.fromKey); incoming.add(edge.toKey) }
  const roots = seats.filter(s => outgoing.has(s.key) && !incoming.has(s.key))
  return roots.length === 1 ? roots[0].key : ''
}
export function projectUserResolutions(rows, { sources, destinations, limit = 10 }) {
  if (!Array.isArray(rows) || rows.length > 80) throw new Error('Invalid bounded resolution response')
  const reports = new Map(); let incomplete = false
  for (const row of rows) {
    if (!row || !sources.includes(row.sourceSession) || !destinations.includes(row.destinationSession) || typeof row.qitemId !== 'string' || !row.qitemId || row.qitemId.length > 200 || /[\u0000-\u001f\u007f]/.test(row.qitemId)) { incomplete = true; continue }
    if (row.resolution === null || row.resolution === undefined || row.resolution === '') continue
    if (typeof row.resolution !== 'string' || typeof row.tsUpdated !== 'string' || !Number.isFinite(Date.parse(row.tsUpdated))) { incomplete = true; continue }
    const body = utf8Excerpt(row.resolution, 16384), preview = utf8Excerpt(row.resolution, 500), title = utf8Excerpt(typeof row.summary === 'string' ? row.summary : 'Untitled external request', 500)
    reports.set(row.qitemId, { id: row.qitemId, title: title.preview, titleTruncated: title.truncated, source: row.sourceSession, destination: row.destinationSession,
      state: typeof row.state === 'string' ? row.state.slice(0, 40) : 'unknown', updatedAt: row.tsUpdated,
      body: body.preview, preview: preview.preview, bodyBytes: body.previewBytes, totalBytes: body.totalBytes, truncated: body.truncated })
  }
  const ordered = [...reports.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id))
  return { reports: ordered.slice(0, limit), incomplete: incomplete || ordered.length > limit }
}
