import test from 'node:test'
import assert from 'node:assert/strict'
import { projectTopology, createTopologyNavigation, topologyViewSummary } from '../src/topology-view.mjs'
import { topologyMermaid, parseTopology, SAMPLE_TOPOLOGY } from '../src/topology.mjs'

function graph(ids, relationships = []) {
  return { name: 'Fixture', pods: [{ uid: 'pod_0', id: 'p', label: 'Fixture' }],
    nodes: ids.map((id, i) => ({ uid: `agent_${i}`, key: `key:${id}`, id, podId: 'p', runtime: 'pi', model: 'Not declared here' })),
    edges: relationships.map(([from, to, kind = 'delegates_to']) => ({ from: `agent_${ids.indexOf(from)}`, to: `agent_${ids.indexOf(to)}`, kind })), warnings: [] }
}
const names = view => view.nodes.map(node => node.id).sort()
function star(count = 7) {
  const children = Array.from({ length: count }, (_, i) => `worker${i}`)
  return graph(['root', 'hub', ...children], [['root', 'hub'], ...children.map(child => ['hub', child])])
}

test('six unique children remain visible; seven form a drill-down boundary, excluding the parent link', () => {
  assert.equal(projectTopology(star(6)).nodes.length, 8)
  const model = star(), before = structuredClone(model), main = projectTopology(model)
  assert.deepEqual(names(main), ['hub', 'root']); assert.deepEqual(main.view.hubs, ['key:hub'])
  assert.equal(main.nodes.find(node => node.id === 'hub').hubChildren, 7)
  assert.equal(main.view.hiddenNodes, 7); assert.equal(main.view.boundaryEdges, 7)
  const focus = projectTopology(model, 'key:hub')
  assert.equal(focus.nodes.length, 8); assert.equal(focus.view.outsideNodes, 1); assert.equal(focus.view.hiddenNodes, 0)
  assert.equal(focus.edges.length, 7); assert.deepEqual(focus.view.hubs, [])
  assert.deepEqual(model, before, 'Projection must not mutate the full snapshot')
})

test('multiple relationships, self-links and incoming fan-in do not inflate the child threshold', () => {
  const model = star(6), hub = model.nodes[1].uid
  model.edges.push({ from: hub, to: hub, kind: 'delegates_to' }, ...model.edges.slice(1).map(edge => ({ ...edge, kind: 'feedback' })), { ...model.edges[1] })
  assert.equal(projectTopology(model).view.hubs.length, 0)
  const fanin = graph(['hub', ...Array.from({ length: 7 }, (_, i) => `parent${i}`)], Array.from({ length: 7 }, (_, i) => [`parent${i}`, 'hub']))
  assert.equal(projectTopology(fanin).view.hubs.length, 0)
})

test('feedback and unknown relation kinds never invent a hierarchy or hide membership', () => {
  const model = star()
  model.edges = model.edges.map(edge => ({ ...edge, kind: 'can_observe' }))
  assert.equal(projectTopology(model).nodes.length, model.nodes.length)
  assert.equal(projectTopology(model).view.hubs.length, 0)
  assert.equal(projectTopology(model, 'key:hub').nodes.length, 1)
  const sample = parseTopology(SAMPLE_TOPOLOGY)
  assert.equal(projectTopology(sample).edges.length, 3, 'Keep the existing feedback edge in main')
})

test('nested hubs stop again in a subdiagram and open only after navigating into them', () => {
  const model = star(), nested = 'worker0'
  for (let i = 0; i < 7; i++) {
    const node = { ...model.nodes[0], uid: `agent_${model.nodes.length}`, key: `key:nested${i}`, id: `nested${i}` }
    model.nodes.push(node); model.edges.push({ from: model.nodes.find(n => n.id === nested).uid, to: node.uid, kind: 'delegates_to' })
  }
  const view = projectTopology(model, 'key:hub')
  assert.equal(view.nodes.length, 8); assert.deepEqual(view.view.hubs, ['key:worker0']); assert.equal(view.view.hiddenNodes, 7)
  assert.equal(projectTopology(model, 'key:worker0').nodes.length, 8)
  const nav = createTopologyNavigation()
  nav.sync(model, 'instance/pod'); nav.enter('key:hub', projectTopology(model)); nav.enter('key:worker0', view)
  assert.deepEqual(nav.path, ['key:hub', 'key:worker0'])
  nav.back(); assert.equal(nav.rootKey, 'key:hub')
  nav.enter('key:worker0', view); nav.main(); assert.equal(nav.rootKey, null)
})

test('shared descendants remain visible through other open paths; unrelated components survive', () => {
  const model = star()
  model.nodes.push({ ...model.nodes[0], uid: 'agent_9', key: 'key:other', id: 'other' }, { ...model.nodes[0], uid: 'agent_10', key: 'key:isolated', id: 'isolated' })
  model.edges.push({ from: 'agent_0', to: 'agent_9', kind: 'delegates_to' }, { from: 'agent_9', to: 'agent_2', kind: 'delegates_to' })
  assert.deepEqual(names(projectTopology(model)), ['hub', 'isolated', 'other', 'root', 'worker0'])
  assert.equal(projectTopology(model).view.hiddenNodes, 6)
})

test('rootless hierarchy cycles are preserved atomically and do not make traversal order-dependent', () => {
  const model = star()
  model.edges.push({ from: 'agent_1', to: 'agent_0', kind: 'delegates_to' })
  const view = projectTopology(model)
  assert.deepEqual(names(view), ['hub', 'root'])
  assert.deepEqual(names(projectTopology({ ...model, nodes: [...model.nodes].reverse(), edges: [...model.edges].reverse() })), names(view))
  const focus = projectTopology(model, 'key:hub')
  assert.equal(focus.nodes.length, 9)
  assert.equal(focus.edges.some(edge => edge.to === 'agent_1'), false)
  assert.equal(focus.view.rootReturnEdges, 1)
  const cycle = graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']])
  assert.equal(projectTopology(cycle).nodes.length, 3)
})

test('focus excludes upstream structure and reports feedback/self-arrows removed to keep the root at the top', () => {
  const model = star()
  model.edges.push({ from: 'agent_2', to: 'agent_1', kind: 'feedback' }, { from: 'agent_1', to: 'agent_1', kind: 'feedback' })
  const view = projectTopology(model, 'key:hub')
  assert.equal(view.edges.length, 7); assert.equal(view.view.rootReturnEdges, 2)
  assert.equal(view.view.boundaryEdges, 1)
  assert.match(topologyViewSummary(view), /2 arrows into the focus root not drawn/)
  assert.throws(() => projectTopology(model, 'missing'), /no longer exists/)
})

test('partial and unqueried observations remain unknown, independently of display omissions', () => {
  const model = { ...star(), source: 'inventory', relationsStatus: 'partial', observedAt: 123, warnings: ['Missing seats remain unknown'] }
  const view = projectTopology(model)
  assert.equal(view.relationsStatus, 'partial'); assert.equal(view.observedAt, 123); assert.deepEqual(view.warnings, model.warnings)
  assert.match(topologyViewSummary(view), /Relationship observation: partial/)
  const noEdges = { ...model, edges: [], relationsStatus: 'unqueried' }
  assert.equal(projectTopology(noEdges).nodes.length, model.nodes.length)
  assert.equal(projectTopology(noEdges).relationsStatus, 'unqueried')
})

test('empty pods are removed only from the display projection and cross-pod shared identities remain distinct', () => {
  const model = star()
  model.pods.push({ uid: 'pod_1', id: 'q', label: 'Other' })
  model.nodes.slice(2).forEach(node => { node.podId = 'q' })
  assert.equal(projectTopology(model).pods.length, 1)
  assert.equal(projectTopology(model, 'key:hub').pods.length, 2)
  assert.equal(model.pods.length, 2)
  const empty = projectTopology({ ...model, nodes: [], edges: [] })
  assert.equal(empty.nodes.length, 0); assert.equal(empty.view.hiddenNodes, 0)
})

test('navigation preserves stable keys, camera and nested history across reorder/metadata refreshes', () => {
  const nav = createTopologyNavigation(), model = star()
  nav.sync(model, 'instance/pod')
  nav.save({ scale: .7, left: 12, top: 34, selectedKey: 'key:root' })
  assert.equal(nav.enter('key:worker0', projectTopology(model)), false, 'Ordinary nodes inspect, not navigate')
  assert.equal(nav.enter('key:hub', projectTopology(model)), true)
  nav.save({ scale: 1.2, left: 5, top: 6 })
  const reordered = { ...model, nodes: [...model.nodes].reverse().map((node, i) => ({ ...node, uid: `agent_${i}`, status: 'running' })) }
  assert.equal(nav.sync(reordered, 'instance/pod'), false); assert.equal(nav.rootKey, 'key:hub')
  assert.equal(nav.camera().scale, 1.2)
  nav.back(); assert.equal(nav.rootKey, null); assert.deepEqual(nav.camera(), { scale: .7, left: 12, top: 34, selectedKey: 'key:root' })
  nav.enter('key:hub', projectTopology(model)); nav.main(); assert.equal(nav.rootKey, null)
  const copy = nav.camera(); copy.scale = 99; assert.equal(nav.camera().scale, .7)
})

test('missing roots, changed instance/pod and YAML source reset navigation without retargeting by UID', () => {
  const nav = createTopologyNavigation(), model = star()
  nav.sync(model, 'instance/pod'); nav.enter('key:hub', projectTopology(model))
  assert.equal(nav.sync({ ...model, nodes: model.nodes.filter(node => node.id !== 'hub') }, 'instance/pod'), true)
  assert.equal(nav.rootKey, null); assert.equal(nav.camera(), null)
  nav.enter('key:hub', projectTopology(model)); nav.sync(model, 'other-instance/same-pod'); assert.equal(nav.rootKey, null)
  nav.enter('key:hub', projectTopology(model)); nav.sync(model, 'other-instance/other-pod'); assert.equal(nav.rootKey, null)
  nav.enter('key:hub', projectTopology(model)); nav.reset(); assert.deepEqual(nav.path, [])
})

test('several independent hubs and an all-disconnected roster retain all entry points', () => {
  const model = star()
  const extra = star()
  const offset = model.nodes.length
  model.nodes.push(...extra.nodes.map((node, i) => ({ ...node, uid: `agent_${i + offset}`, key: `other:${node.key}`, id: `other:${node.id}` })))
  model.edges.push(...extra.edges.map(edge => ({ ...edge, from: `agent_${Number(edge.from.slice(6)) + offset}`, to: `agent_${Number(edge.to.slice(6)) + offset}` })))
  assert.equal(projectTopology(model).nodes.length, 4); assert.equal(projectTopology(model).view.hubs.length, 2)
  assert.equal(projectTopology({ ...model, edges: [] }).nodes.length, model.nodes.length)
})

test('projection emits only actual edges with visible endpoints and deterministic counts for every focus', () => {
  // Bounded deterministic mixed graphs include cycles, self-edges, fan-in and dense fan-out.
  let seed = 73
  const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n }
  for (let trial = 0; trial < 20; trial++) {
    const ids = Array.from({ length: 20 }, (_, i) => String(i)), relationships = []
    for (let i = 0; i < 70; i++) relationships.push([String(random(20)), String(random(20)), random(3) ? 'delegates_to' : 'feedback'])
    const model = graph(ids, relationships), original = structuredClone(model)
    for (const key of [null, ...model.nodes.map(node => node.key)]) {
      const view = projectTopology(model, key), visible = new Set(view.nodes.map(node => node.uid))
      assert.equal(view.nodes.length + view.view.hiddenNodes + view.view.outsideNodes, model.nodes.length)
      for (const edge of view.edges) { assert.ok(model.edges.includes(edge)); assert.ok(visible.has(edge.from) && visible.has(edge.to)) }
      assert.equal(view.edges.some(edge => key !== null && edge.to === model.nodes.find(node => node.key === key).uid), false)
    }
    assert.deepEqual(model, original)
  }
})

test('Mermaid source contains only the selected projection, never omitted node definitions', () => {
  const source = topologyMermaid(projectTopology(star()))
  assert.match(source, /agent_1\[/); assert.equal(source.includes('agent_2'), false)
  assert.match(source, /classDef topologyHub/); assert.match(source, /Hub · 7 direct targets/)
  assert.match(source, /:::topologyHub/)
  const focus = topologyMermaid(projectTopology(star(), 'key:hub'), 'TB')
  assert.equal(focus.startsWith('flowchart TB'), true)
  assert.match(focus, /Focus root/); assert.equal(focus.includes(':::topologyHub'), false)
})

test('the largest accepted roster can be projected without losing the original input bounds', () => {
  const model = star(78), view = projectTopology(model)
  assert.equal(model.nodes.length, 80); assert.equal(view.nodes.length, 2); assert.equal(view.view.hiddenNodes, 78)
  assert.equal(projectTopology(model, 'key:hub').nodes.length, 79)
})

test('hostile hub captions remain quoted Mermaid labels in either view', () => {
  const model = star(), caption = 'hub"<script> %%{init:bad}%% $$math$$ `code` | &'
  model.nodes[1].id = caption
  const main = topologyMermaid(projectTopology(model)), focus = topologyMermaid(projectTopology(model, 'key:hub'), 'TB')
  for (const source of [main, focus]) {
    assert.equal(source.includes('<script>'), false); assert.equal(source.includes('%%{'), false)
    assert.equal(source.split('\n').some(line => line.startsWith('click ')), false)
    assert.equal(source.split('\n').filter(line => line.startsWith('subgraph ')).length, 1)
  }
})
