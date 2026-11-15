// A read-only display projection. Original membership/relationships are never mutated.
export const HUB_THRESHOLD = 7
const hierarchical = edge => edge.kind === 'delegates_to'

function hierarchy(topology) {
  const children = new Map(topology.nodes.map(node => [node.uid, new Set()]))
  for (const edge of topology.edges) if (hierarchical(edge) && edge.from !== edge.to && children.has(edge.from) && children.has(edge.to)) children.get(edge.from).add(edge.to)

  // Condense cycles before choosing roots: a rootless cycle must not disappear,
  // nor should an arbitrary member ordering change which branches are visible.
  let index = 0
  const indices = new Map(), low = new Map(), stack = [], stacked = new Set(), components = [], componentOf = new Map()
  function visit(uid) {
    indices.set(uid, index); low.set(uid, index++); stack.push(uid); stacked.add(uid)
    for (const to of children.get(uid)) {
      if (!indices.has(to)) { visit(to); low.set(uid, Math.min(low.get(uid), low.get(to))) }
      else if (stacked.has(to)) low.set(uid, Math.min(low.get(uid), indices.get(to)))
    }
    if (low.get(uid) !== indices.get(uid)) return
    const members = []
    let member
    do { member = stack.pop(); stacked.delete(member); componentOf.set(member, components.length); members.push(member) } while (member !== uid)
    components.push({ members, children: new Set(), incoming: 0, hub: members.some(id => children.get(id).size >= HUB_THRESHOLD) })
  }
  for (const node of topology.nodes) if (!indices.has(node.uid)) visit(node.uid)
  for (const [from, targets] of children) for (const to of targets) {
    const a = componentOf.get(from), b = componentOf.get(to)
    if (a !== b && !components[a].children.has(b)) { components[a].children.add(b); components[b].incoming++ }
  }
  return { children, components, componentOf }
}

export function projectTopology(topology, rootKey = null) {
  const root = rootKey === null ? null : topology.nodes.find(node => node.key === rootKey)
  if (rootKey !== null && !root) throw new Error('The topology focus no longer exists.')
  const { children, components, componentOf } = hierarchy(topology)
  const rootComponent = root ? componentOf.get(root.uid) : null
  const seeds = root ? [rootComponent] : components.flatMap((component, i) => component.incoming ? [] : [i])
  function walk(stopAtHubs) {
    const seen = new Set(), pending = [...seeds]
    while (pending.length) {
      const i = pending.pop()
      if (seen.has(i)) continue
      seen.add(i)
      // The current root is opened. Only subsequent hubs are boundaries.
      if (stopAtHubs && components[i].hub && i !== rootComponent) continue
      pending.push(...components[i].children)
    }
    return new Set([...seen].flatMap(i => components[i].members))
  }
  const scope = walk(false), visible = walk(true)
  const nodes = topology.nodes.filter(node => visible.has(node.uid)).map(node => ({ ...node,
    hubChildren: children.get(node.uid).size >= HUB_THRESHOLD ? children.get(node.uid).size : 0 }))
  // A focus view has one semantic root. Omit arrows back into that root (including
  // feedback/self-links) rather than allowing layout to pull it below its children.
  const edges = topology.edges.filter(edge => visible.has(edge.from) && visible.has(edge.to) && (!root || edge.to !== root.uid))
  const podIds = new Set(nodes.map(node => node.podId))
  return { ...topology, pods: topology.pods.filter(pod => podIds.has(pod.id)), nodes, edges,
    view: { rootKey: root?.key ?? null, rootId: root?.id ?? null, totalNodes: topology.nodes.length, totalEdges: topology.edges.length,
      hiddenNodes: scope.size - visible.size, outsideNodes: topology.nodes.length - scope.size,
      boundaryEdges: topology.edges.filter(edge => visible.has(edge.from) !== visible.has(edge.to)).length,
      rootReturnEdges: root ? topology.edges.filter(edge => visible.has(edge.from) && edge.to === root.uid).length : 0,
      hubs: nodes.filter(node => node.hubChildren && node.key !== root?.key).map(node => node.key) } }
}

export function topologyViewSummary(projection) {
  const { view, nodes, edges } = projection
  const observation = projection.source === 'inventory' ? ` Relationship observation: ${projection.relationsStatus}.` : ''
  return `${view.rootKey === null ? 'Main overview' : `Subdiagram: ${view.rootId}`} · ${nodes.length} / ${view.totalNodes} nodes shown · ${edges.length} / ${view.totalEdges} relationships shown · ${view.hiddenNodes} nodes beyond hubs · ${view.outsideNodes} nodes outside this scope · ${view.boundaryEdges} boundary relationships not drawn · ${view.rootReturnEdges} arrows into the focus root not drawn.${observation} Hierarchy: delegates_to only; other relationships do not define descendants.${view.hubs.length ? ' Select a hub to view its downstream structure.' : ''}`
}

// Keys, not generated SVG UIDs, survive reordered native snapshots. Cameras and
// history are scoped to the instance + pod (or a single YAML render).
export function createTopologyNavigation() {
  let scope = null, path = []
  const cameras = new Map()
  const rootKey = () => path.at(-1) ?? null
  return {
    get rootKey() { return rootKey() },
    get path() { return [...path] },
    reset() { scope = null; path = []; cameras.clear() },
    sync(topology, nextScope) {
      if (scope !== nextScope) { scope = nextScope; path = []; cameras.clear(); return false }
      if (path.some(key => !topology.nodes.some(node => node.key === key))) { path = []; cameras.clear(); return true }
      return false
    },
    enter(key, projection) {
      if (!projection.view.hubs.includes(key)) return false
      const previous = path.indexOf(key)
      path = previous < 0 ? [...path, key] : path.slice(0, previous + 1)
      return true
    },
    back() { path.pop() },
    main() { path = [] },
    save(camera) { cameras.set(rootKey(), { ...camera }) },
    camera() { const value = cameras.get(rootKey()); return value ? { ...value } : null }
  }
}
