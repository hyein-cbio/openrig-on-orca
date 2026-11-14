import { parseDocument, isAlias, isMap, isSeq } from 'yaml'

export const TOPOLOGY_LIMITS = Object.freeze({ bytes: 262144, pods: 16, agents: 80, edges: 160, depth: 32, ast: 20000 })
const problem = message => { throw new Error(message) }
const text = (value, fallback = '', max = 160) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, max) : '') || fallback
const get = (object, key) => object instanceof Map ? object.get(key) : undefined
const id = value => typeof value === 'string' && Boolean(value.trim()) && value.length <= 120 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)

function entries(value, label) {
  if (Array.isArray(value)) return value.map(item => [get(item, 'id'), item])
  if (value instanceof Map) return [...value.entries()]
  return problem(`${label} must be a sequence or an ID-keyed mapping.`)
}

export function parseTopology(source) {
  if (typeof source !== 'string' || !source.trim()) problem('Choose or paste a RigSpec YAML document first.')
  if (new TextEncoder().encode(source).length > TOPOLOGY_LIMITS.bytes) problem('YAML exceeds the 256 KiB local input limit.')
  let document
  try { document = parseDocument(source, { uniqueKeys: true, strict: true, schema: 'core', merge: false, logLevel: 'silent' }) }
  catch { return problem('YAML could not be parsed. Check its structure; no source excerpt was logged.') }
  if (document.errors.length || document.warnings.length) problem('Invalid, duplicate-key, multi-document or custom-tag YAML. Check the source; it was not logged.')
  // Walk the AST before materializing objects. Aliases and excessive nesting are not needed for this projection.
  const pending = [[document.contents, 0]]
  let count = 0
  while (pending.length) {
    const [node, depth] = pending.pop()
    if (++count > TOPOLOGY_LIMITS.ast || depth > TOPOLOGY_LIMITS.depth) problem('YAML nesting or node count exceeds the local safety limit.')
    if (isAlias(node)) problem('YAML aliases are not supported; expand the referenced values before rendering.')
    if (isMap(node)) for (const pair of node.items) pending.push([pair.key, depth + 1], [pair.value, depth + 1])
    else if (isSeq(node)) for (const item of node.items) pending.push([item, depth + 1])
  }
  const spec = document.toJS({ mapAsMap: true, maxAliasCount: 0 })
  if (!(spec instanceof Map)) problem('Expected one RigSpec mapping with pods and members.')
  const podEntries = entries(get(spec, 'pods'), 'pods')
  if (!podEntries.length || podEntries.length > TOPOLOGY_LIMITS.pods) problem('Render between 1 and 16 pods at a time.')
  const pods = [], nodes = [], edges = [], warnings = [], nodeKeys = new Map(), aliases = new Map(), podIds = new Set()
  const warn = message => { if (warnings.length < 20 && !warnings.includes(message)) warnings.push(message) }
  const alias = (name, node) => aliases.set(name, aliases.has(name) ? null : node)
  for (const [fallback, pod] of podEntries) {
    const podId = get(pod, 'id') ?? fallback
    if (!id(podId) || podIds.has(podId)) problem('Each pod needs a unique string ID (at most 120 characters).')
    podIds.add(podId)
    const group = { uid: `pod_${pods.length}`, id: podId, label: text(get(pod, 'label'), podId, 60) }
    pods.push(group)
    for (const [key, member] of entries(get(pod, 'members'), 'members')) {
      if (!(member instanceof Map)) problem('Each member must be a mapping with an ID and declared agent metadata.')
      const memberId = get(member, 'id') ?? key
      if (!id(memberId)) problem('Each member needs a string ID (at most 120 characters).')
      const identity = JSON.stringify([podId, memberId])
      if (nodeKeys.has(identity)) problem('Member IDs must be unique within each pod.')
      if (nodes.length >= TOPOLOGY_LIMITS.agents) problem('Render at most 80 agents at a time.')
      const node = { uid: `agent_${nodes.length}`, key: identity, podId, id: memberId,
        role: text(get(member, 'role'), 'Not declared here'), runtime: text(get(member, 'runtime'), 'Not declared here'),
        model: text(get(member, 'model'), 'Not declared here'), agentRef: text(get(member, 'agent_ref'), 'Not declared here') }
      nodes.push(node); nodeKeys.set(identity, node)
      alias(memberId, node); alias(`${podId}.${memberId}`, node); alias(`${podId}/${memberId}`, node)
    }
  }
  if (!nodes.length) problem('This document contains no members to visualize.')
  const resolve = (reference, podId) => {
    if (!id(reference)) return null
    return (podId && nodeKeys.get(JSON.stringify([podId, reference]))) || aliases.get(reference) || null
  }
  const dedupe = new Set()
  function addEdges(declared, podId) {
    if (declared === undefined) return
    if (!Array.isArray(declared)) return problem('edges must be a sequence of from/to/kind mappings.')
    if (declared.length > TOPOLOGY_LIMITS.edges) problem('Render at most 160 declared edges at a time.')
    for (const edge of declared) {
      if (dedupe.size >= TOPOLOGY_LIMITS.edges) problem('Render at most 160 resolved edges at a time.')
      const from = resolve(get(edge, 'from'), podId), to = resolve(get(edge, 'to'), podId)
      if (!from || !to) { warn('Some edges have missing or ambiguous endpoints and were omitted. Use pod.member references for cross-pod edges.'); continue }
      const kind = text(get(edge, 'kind'), 'relationship', 24)
      const key = JSON.stringify([from.uid, to.uid, kind])
      if (dedupe.has(key)) continue
      dedupe.add(key); edges.push({ from: from.uid, to: to.uid, kind })
    }
  }
  for (const [fallback, pod] of podEntries) addEdges(get(pod, 'edges'), get(pod, 'id') ?? fallback)
  addEdges(get(spec, 'edges'))
  if (nodes.some(node => node.runtime === 'Not declared here' || node.model === 'Not declared here')) warn('Runtime/model values may be defined in AgentSpecs or native defaults. Referenced files and effective settings are not resolved.')
  return { name: text(get(spec, 'name'), 'Untitled rig', 100), pods, nodes, edges, warnings }
}

// Quoted plain-text labels only. Normalize grammar/HTML/math punctuation rather than
// entities: Mermaid's SVG edge/cluster labels do not consistently decode entities.
const punctuation = { '"': '”', '<': '‹', '>': '›', '`': '’', '#': '＃', '%': '％', '$': '＄', '&': '＆', '\\': '／', '|': '¦', '{': '(', '}': ')', ':': '∶' }
export const mermaidLabel = value => String(value).replace(/["<>`#%$&\\|{}:]/g, char => punctuation[char]).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
export function topologyMermaid(topology, direction = 'LR') {
  if (!['LR', 'TB'].includes(direction)) problem('Unsupported layout direction.')
  const lines = [`flowchart ${direction}`]
  for (const pod of topology.pods) {
    lines.push(`subgraph ${pod.uid}["${mermaidLabel(pod.label)}"]`, `direction ${direction}`)
    for (const node of topology.nodes.filter(n => n.podId === pod.id)) {
      const label = [text(node.id, '', 40), text(node.runtime, '', 24), ...(node.model !== 'Not declared here' ? [text(node.model, '', 40)] : []), ...(topology.source === 'inventory' ? [text(`${node.status} · ${node.activity}${node.attention ? ' · attention' : ''}`, '', 60)] : [])].map(mermaidLabel).join('<br/>')
      lines.push(`${node.uid}["${label}"]`)
    }
    lines.push('end')
  }
  // Dagre stacks disconnected nodes on the cross axis. Rank an edgeless roster
  // with invisible layout links; these are not observed or declared relationships.
  if (!topology.edges.length && topology.nodes.length > 1) {
    lines.push('%% Invisible layout links only; no relationship edges are implied.')
    for (let i = 1; i < topology.nodes.length; i++) lines.push(`${topology.nodes[i - 1].uid} ~~~ ${topology.nodes[i].uid}`)
  }
  for (const edge of topology.edges) lines.push(`${edge.from} ${edge.kind === 'delegates_to' ? '-->' : '-.->'}|"${mermaidLabel(edge.kind.replaceAll('_', ' '))}"| ${edge.to}`)
  const source = lines.join('\n')
  if (source.length > 160000) problem('Diagram labels exceed the rendering budget; shorten the declared labels.')
  return source
}

export const topologyNodeId = svgId => typeof svgId === 'string' ? /(?:^|-)flowchart-(agent_\d+)-\d+$/.exec(svgId)?.[1] || null : null

export const SAMPLE_TOPOLOGY = `version: '0.2'
name: Build & Review
pods:
  - id: dev
    label: Product team
    members:
      - id: lead
        role: Coordinate the work
        runtime: pi
        agent_ref: local:agents/lead
      - id: builder
        role: Implement and test
        runtime: codex
        agent_ref: local:agents/builder
      - id: reviewer
        role: Review the exact candidate
        runtime: claude-code
        agent_ref: local:agents/reviewer
    edges:
      - kind: delegates_to
        from: lead
        to: builder
      - kind: delegates_to
        from: builder
        to: reviewer
      - kind: feedback
        from: reviewer
        to: builder
edges: []
`
