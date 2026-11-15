import mermaid from './mermaid/mermaid.esm.min.mjs'
import DOMPurify from 'dompurify'
import { reportPrefix } from './report-preview.mjs'
import { topologyForPod } from './pods.mjs'
import { parseTopology, topologyMermaid, topologyNodeId, SAMPLE_TOPOLOGY, TOPOLOGY_LIMITS } from './topology.mjs'

const $ = id => document.getElementById(id)
const sourceObservers = new Set()
const sourceChanged = kind => { hideReport(); for (const listener of sourceObservers) listener(kind) }
export function observeTopologySource(listener) { sourceObservers.add(listener); return () => sourceObservers.delete(listener) }
let reportReader = null, reportEpoch = 0, reportAnchor = null
export function setReportReader(reader) { reportReader = typeof reader === 'function' ? reader : null; hideReport() }
function hideReport() {
  reportEpoch++; $('seat-report-tooltip').hidden = true; $('seat-report-tooltip').replaceChildren()
  reportAnchor?.removeAttribute('aria-describedby'); reportAnchor = null
}
function placeReport(anchor) {
  const tip = $('seat-report-tooltip'), box = anchor.getBoundingClientRect(), bounds = tip.getBoundingClientRect()
  const left = Math.max(12, Math.min(box.left + box.width / 2 - bounds.width / 2, innerWidth - bounds.width - 12))
  const top = box.bottom + 10 + bounds.height <= innerHeight - 12 ? box.bottom + 10 : Math.max(12, box.top - bounds.height - 10)
  tip.style.left = `${left}px`; tip.style.top = `${Math.max(12, Math.min(top, innerHeight - bounds.height - 12))}px`
}
async function showReport(node, anchor) {
  hideReport(); const revision = reportEpoch, current = model, tip = $('seat-report-tooltip')
  reportAnchor = anchor; anchor.setAttribute('aria-describedby', tip.id)
  const item = (tag, text) => { const element = document.createElement(tag); element.textContent = text; return element }
  tip.replaceChildren(item('strong', `${node.id} · Last outbound record`), item('p', 'Reading a bounded native outbox preview…')); tip.hidden = false; placeReport(anchor)
  let result
  try { result = current?.source === 'inventory' && reportReader ? await reportReader(node.key) : { status: 'unverified', detail: 'No native report lookup is available for this declaration/standalone preview.' } }
  catch { result = { status: 'unverified', detail: 'Native report preview unavailable.' } }
  if (revision !== reportEpoch || current !== model || !anchor.isConnected) return
  tip.replaceChildren(item('strong', `${node.id} · ${result.status === 'recorded' ? result.kind || 'Recorded outbound message' : result.status === 'none' ? 'No recorded message found' : 'Preview unverified'}`))
  if (result.status === 'recorded' && typeof result.preview === 'string') {
    const preview = reportPrefix(result.preview), stamp = Number.isFinite(Date.parse(result.recordedAt)) ? new Date(result.recordedAt).toLocaleString() : 'Unknown time'
    tip.append(item('p', `To: ${String(result.recipient || 'Unknown').slice(0, 300)} · Recorded: ${stamp}`), item('p', `Native delivery state: ${String(result.delivery || 'unknown').slice(0, 40)}`), item('pre', preview.preview), item('p', `${preview.previewBytes} / ${result.totalBytes ?? preview.previewBytes} UTF-8 bytes${result.truncated ? ' · truncated' : ''} · raw excerpt, not an LLM summary`), item('p', 'Seat history may include an earlier occupant. A recorded message does not prove acknowledgment or correct work.'))
  } else tip.append(item('p', String(result.detail || 'No verified preview.').slice(0, 700)))
  placeReport(anchor)
}
window.addEventListener('scroll', () => { if (reportAnchor && !$('seat-report-tooltip').hidden) { const box = reportAnchor.getBoundingClientRect(); if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) hideReport(); else placeReport(reportAnchor) } }, { capture: true }); window.addEventListener('resize', hideReport)
const source = $('yaml-source'), viewport = $('viewport'), diagram = $('diagram')
let model = null, selected = '', selectedKey = '', svg = null, svgText = '', natural = { width: 1, height: 1 }, scale = 1
let epoch = 0, loadEpoch = 0, renderQueue = Promise.resolve(), dirty = false, directionChosen = false
function adoptNativeTheme() {
  const styles = getComputedStyle(document.documentElement)
  for (const name of ['background', 'foreground', 'card', 'muted', 'muted-foreground', 'border']) {
    const raw = styles.getPropertyValue(`--orca-${name}`).trim()
    const color = CSS.supports('color', raw) ? raw : CSS.supports('color', `hsl(${raw})`) ? `hsl(${raw})` : ''
    if (color) document.documentElement.style.setProperty(`--studio-${name}`, color)
  }
}
const dark = () => document.documentElement.classList.contains('dark') || (!document.documentElement.classList.contains('light') && matchMedia('(prefers-color-scheme: dark)').matches)
const notice = message => { $('notice').textContent = message }
function origin(kind) {
  const inventory = kind === 'inventory'
  $('topology-origin').textContent = inventory ? 'Observed snapshot' : 'Not live status'
  $('topology-origin').classList.remove('stale')
  $('topology-inspector-note').textContent = inventory ? 'Observations, not guarantees.' : 'Declarations, not guarantees.'
  $('topology-eyebrow').textContent = inventory ? 'NATIVE POD INVENTORY' : 'DECLARED TOPOLOGY'
  $('agent-noun').textContent = inventory ? 'seats' : 'agents'; $('entity-details').textContent = inventory ? 'SEAT DETAILS' : 'AGENT DETAILS'
  $('topology-stage').setAttribute('aria-label', inventory ? 'Native pod inventory' : 'Declared topology')
  $('inventory-legend').hidden = !inventory; $('declaration-legend').hidden = inventory
}
const selectable = () => [...diagram.querySelectorAll('g.node')]
const nodeId = node => topologyNodeId(node.id)
function details(node) {
  selected = node?.uid || ''; selectedKey = node?.key || ''
  $('agent-name').textContent = node?.id || 'Select an agent'
  $('agent-hint').textContent = node ? (model?.source === 'inventory' ? 'Observed in the selected native pod snapshot. This is not continuous live polling.' : 'Declared in the rendered YAML snapshot. Effective native settings may differ.') : 'Select a node in the diagram to inspect its declared settings.'
  const shown = node && model?.source === 'inventory' ? { ...node, podId: node.podNamespace } : node
  for (const [element, field] of [['detail-pod', 'podId'], ['detail-role', 'role'], ['detail-runtime', 'runtime'], ['detail-model', 'model'], ['detail-reference', 'agentRef'], ['detail-lifecycle', 'status'], ['detail-activity', 'activity'], ['detail-attention', 'attention']]) $(element).textContent = shown?.[field] ?? '—'
  for (const item of selectable()) item.classList.toggle('selected', nodeId(item) === selected)
}
function resize(next) {
  if (!svg) return
  scale = Math.max(.04, Math.min(4, next))
  svg.style.width = `${natural.width * scale}px`; svg.style.height = `${natural.height * scale}px`
}
function fit() {
  if (!svg) return
  resize(Math.min((viewport.clientWidth - 48) / natural.width, innerWidth < 700 ? 1.4 : (viewport.clientHeight - 48) / natural.height, 1.4))
  viewport.scrollTo({ left: 0, top: 0 })
}
function clearGraph() {
  hideReport(); epoch++; model = null; svg = null; svgText = ''; diagram.replaceChildren(); details(null)
  $('empty').hidden = false; $('export').disabled = true; $('warnings').replaceChildren(); $('mermaid-source').value = ''
  $('rig-name').textContent = 'No valid topology'
  for (const id of ['pod-count', 'agent-count', 'edge-count']) $(id).textContent = '—'
}
function markDirty() {
  sourceChanged('yaml')
  loadEpoch++; epoch++; dirty = true; $('export').disabled = true
  notice('Source changed · Render diagram to apply it. The map below is the previous snapshot.')
}
let observationFreshness = null
const geometryKey = value => value && JSON.stringify([value.name, value.pods, value.nodes, [...value.edges].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])
export function updateObservationFreshness(value) {
  observationFreshness = value
  if (model?.source !== 'inventory') return
  const stale = Boolean(value?.seatsStale || value?.relationsStale)
  $('topology-origin').textContent = stale ? 'Stale / incomplete observation' : 'Observed snapshot'
  $('topology-origin').classList.toggle('stale', stale)
  $('inventory-legend').textContent = value?.relationsStale ? `Older / incomplete relationships · ${model.relationsStatus} snapshot` : `Native directed relationships · ${model.relationsStatus}`
  if (stale) notice('Older or incomplete observation · see last successful seat/relationship times above. This is not confirmed current state.')
}
function updateMetadata(current) {
  $('rig-name').textContent = current.name
  $('pod-count').textContent = current.pods.length; $('pod-noun').textContent = current.pods.length === 1 ? 'pod' : 'pods'; $('agent-count').textContent = current.nodes.length; $('edge-count').textContent = current.source === 'inventory' && ['unqueried', 'loading', 'unavailable'].includes(current.relationsStatus) ? '—' : current.source === 'inventory' && current.relationsStatus === 'partial' ? `${current.edges.length} observed` : current.edges.length
  $('empty').hidden = true; $('error').hidden = true
  $('warnings').replaceChildren(...current.warnings.map(message => { const li = document.createElement('li'); li.textContent = message; return li }))
  origin(current.source)
  if (current.source === 'inventory') $('inventory-legend').textContent = `Native directed relationships · ${current.relationsStatus}`
  $('export').disabled = dirty; notice(dirty ? 'Source changed · The map is the previous snapshot. Render to apply the source.' : current.source === 'inventory' ? `Native pod snapshot · ${new Date(current.observedAt).toLocaleString()}. Relationships: ${current.relationsStatus}${current.relationshipObservedAt ? ` · ${new Date(current.relationshipObservedAt).toLocaleString()}` : ''}. No connections were inferred.` : 'Ready · Declared topology only. Select an agent to inspect its settings.')
  if (current.source === 'inventory') updateObservationFreshness(observationFreshness)
}
function scheduleRender() {
  hideReport()
  const current = model, direction = $('direction').value, revision = ++epoch
  if (!current) return Promise.resolve()
  $('export').disabled = true; notice('Rendering the declared topology locally…')
  renderQueue = renderQueue.catch(() => {}).then(async () => {
    if (revision !== epoch) return
    const isDark = dark()
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, layout: 'dagre', htmlLabels: false,
      maxTextSize: 160000, maxEdges: 160, markdownAutoWrap: false, theme: 'base',
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
      themeVariables: { fontSize: '13px', primaryColor: isDark ? '#26374c' : '#f0f4ff', primaryTextColor: isDark ? '#e4ecf7' : '#27364e', primaryBorderColor: isDark ? '#526988' : '#b4c3e2', lineColor: '#8d9db9', clusterBkg: isDark ? '#1d2a3b' : '#f8faff', clusterBorder: isDark ? '#3c4c64' : '#dbe4f3', edgeLabelBackground: isDark ? '#1b2330' : '#ffffff' },
      flowchart: { htmlLabels: false, useMaxWidth: false, curve: 'basis', padding: 18, nodeSpacing: 40, rankSpacing: 55 } })
    try {
      const code = topologyMermaid(current, direction)
      const rendered = await mermaid.render(`rig_diagram_${revision}`, code)
      if (revision !== epoch) return
      // Only generated flowcharts enter Mermaid. Sanitize again before attaching or exporting an SVG.
      const clean = DOMPurify.sanitize(rendered.svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['script', 'foreignObject', 'image', 'a', 'iframe', 'animate', 'set', 'use'], FORBID_ATTR: ['href', 'xlink:href'] })
      const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml')
      const root = parsed.documentElement
      if (root.localName !== 'svg' || parsed.querySelector('parsererror')) throw new Error('Invalid rendered SVG')
      diagram.replaceChildren(document.importNode(root, true)); svg = diagram.querySelector('svg')
      const box = svg.viewBox.baseVal
      if (!box.width || !box.height) throw new Error('Empty rendered SVG')
      natural = { width: box.width, height: box.height }; svgText = svg.outerHTML
      svg.setAttribute('aria-label', `${current.name}: ${current.source === 'inventory' ? 'native pod seats and reported relationships' : 'declared pods, agents and relationships'}`)
      for (const element of selectable()) {
        const node = current.nodes.find(n => n.uid === nodeId(element))
        if (!node) continue
        element.setAttribute('role', 'button'); element.setAttribute('tabindex', '0'); element.setAttribute('aria-label', `Inspect ${node.id}`)
        element.addEventListener('mouseenter', () => { void showReport(node, element) })
        element.addEventListener('mouseleave', hideReport)
        element.addEventListener('focus', () => { void showReport(node, element) }); element.addEventListener('blur', hideReport)
        element.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); hideReport() } })
        element.addEventListener('click', () => { hideReport(); details(node) })
        element.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); hideReport(); details(node) } })
      }
      details(current.nodes.find(n => n.key === selectedKey) || current.nodes[0]); fit()
      $('mermaid-source').value = code; updateMetadata(current)
    } catch {
      if (revision !== epoch) return
      clearGraph(); $('error').textContent = 'The local renderer could not draw this projection. Simplify the diagram or shorten its labels; no agent operation was requested.'; $('error').hidden = false
      notice('Rendering failed. No source or diagram was uploaded.')
    }
  })
  return renderQueue
}
function renderSource() {
  sourceChanged('yaml'); origin('yaml')
  loadEpoch++
  try { model = parseTopology(source.value); dirty = false; $('error').hidden = true; return scheduleRender() }
  catch (error) { clearGraph(); $('error').textContent = error.message; $('error').hidden = false; notice('Source needs attention · The previous map was cleared.'); return Promise.resolve() }
}
source.addEventListener('input', markDirty)
$('render').addEventListener('click', renderSource)
$('sample').addEventListener('click', () => { source.value = SAMPLE_TOPOLOGY; $('source-name').textContent = 'Built-in example'; renderSource() })
$('yaml-file').addEventListener('change', async event => {
  const file = event.target.files?.[0], revision = ++loadEpoch
  if (!file) return
  sourceChanged('yaml')
  try {
    if (file.size > TOPOLOGY_LIMITS.bytes) throw new Error('YAML exceeds the 256 KiB local input limit.')
    const value = await file.text()
    if (revision !== loadEpoch) return
    source.value = value; $('source-name').textContent = file.name.slice(0, 100); await renderSource()
  } catch {
    if (revision !== loadEpoch) return
    clearGraph(); $('error').textContent = 'Could not read the selected file, or it exceeded 256 KiB. Nothing was uploaded.'; $('error').hidden = false; notice('File not loaded.')
  } finally { event.target.value = '' }
})
$('direction').addEventListener('change', () => { directionChosen = true; if (model) scheduleRender() })
$('zoom-in').addEventListener('click', () => resize(scale * 1.25))
$('zoom-out').addEventListener('click', () => resize(scale / 1.25))
$('fit').addEventListener('click', fit)
$('export').addEventListener('click', async () => {
  if (!svgText || dirty) return
  const data = svgText, suggestedName = `${(model.name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 64) || 'rig')}-topology.svg`
  try {
    if (window.orca?.files?.saveAs) {
      const result = await window.orca.files.saveAs({ suggestedName, mimeType: 'image/svg+xml', data })
      notice(result.status === 'saved' ? 'SVG saved. It contains the displayed topology.' : 'Save cancelled; no file was written.')
    } else {
      const url = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml' })), link = document.createElement('a')
      link.href = url; link.download = suggestedName; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      notice('SVG download requested. It contains the displayed topology.')
    }
  } catch { notice('SVG could not be saved. The current diagram is unchanged.') }
})
const themeChanged = () => { adoptNativeTheme(); if (model) scheduleRender() }
window.orca?.on?.('theme', themeChanged)
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeChanged)
let lastViewportWidth = 0
new ResizeObserver(() => {
  const width = viewport.clientWidth, preferred = innerWidth < 700 ? 'TB' : 'LR'
  if (!directionChosen && $('direction').value !== preferred) { $('direction').value = preferred; if (model) scheduleRender() }
  else if (svg && width !== lastViewportWidth) fit()
  lastViewportWidth = width
}).observe(document.querySelector('.map-card'))
export function displayPodSnapshot(pod, seats = [], observedAt = Date.now(), relations = null, freshness = null) {
  loadEpoch++; observationFreshness = freshness
  if (!pod) {
    sourceChanged('inventory'); origin('inventory'); clearGraph(); $('error').hidden = true; $('rig-name').textContent = 'Select an OpenRig pod'; $('topology-origin').textContent = 'Native inventory'; $('empty').textContent = 'Refresh and select an actual rig / pod above. No example is substituted.'; notice('No pod selected. This dashboard does not auto-load an example.'); return
  }
  try {
    const next = topologyForPod(pod, seats, observedAt, relations)
    if (model?.source === 'inventory' && svg && !dirty && geometryKey(model) === geometryKey(next)) { Object.assign(model, next); updateMetadata(model); return }
    sourceChanged('inventory'); origin('inventory'); model = next; dirty = false; $('error').hidden = true; scheduleRender()
  }
  catch (error) { clearGraph(); $('rig-name').textContent = pod.label; $('topology-origin').textContent = 'Native inventory'; $('error').textContent = error.message; $('error').hidden = false; notice('The complete seat list remains below; no partial diagram was substituted.') }
}
adoptNativeTheme()
if (innerWidth < 700) $('direction').value = 'TB'
if (document.getElementById('dashboard-pod')) { $('yaml-tools').open = false; $('source-name').textContent = 'No YAML loaded'; displayPodSnapshot(null) }
else { source.value = SAMPLE_TOPOLOGY; renderSource() }
