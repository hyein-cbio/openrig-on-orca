// Shared by both panels; keep this module free of Node-only imports.
/** @param {import('./protocol').Workspace | undefined} workspace */
export function workspaceLabel(workspace) {
  if (!workspace) return 'Unknown workspace'
  const directory = workspace.path.split(/[\\/]/).filter(Boolean).at(-1)
  const project = workspace.project?.trim() || directory || 'Local project'
  const name = workspace.name.trim() || directory || 'Workspace'
  return `${project} / ${name}`
}

/** @param {import('./protocol').Workspace[]} workspaces */
export function workspaceOptions(workspaces) {
  const local = workspaces.filter(w => !w.hostId || w.hostId === 'local')
  const labels = local.map(workspaceLabel)
  const counts = new Map()
  for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1)
  const detailed = local.map((w, i) => counts.get(labels[i]) > 1 ? `${labels[i]} — ${w.path}` : labels[i])
  const duplicates = new Map()
  for (const label of detailed) duplicates.set(label, (duplicates.get(label) || 0) + 1)
  return local.map((w, i) => ({
    value: w.id,
    label: duplicates.get(detailed[i]) > 1 ? `${detailed[i]} (${w.id})` : detailed[i]
  }))
}
