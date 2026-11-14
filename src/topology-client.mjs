import mermaid from './mermaid/mermaid.esm.min.mjs'
import DOMPurify from 'dompurify'
import { parseTopology, topologyMermaid, topologyNodeId, SAMPLE_TOPOLOGY, TOPOLOGY_LIMITS } from './topology.mjs'

const $ = id => document.getElementById(id)
const source = $('yaml-source'), viewport = $('viewport'), diagram = $('diagram')
let model = null, selected = '', svg = null, svgText = '', natural = { width: 1, height: 1 }, scale = 1
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
const selectable = () => [...diagram.querySelectorAll('g.node')]
const nodeId = node => topologyNodeId(node.id)
function details(node) {
  selected = node?.uid || ''
  $('agent-name').textContent = node?.id || 'Select an agent'
  $('agent-hint').textContent = node ? 'Declared in the rendered YAML snapshot. Effective native settings may differ.' : 'Select a node in the diagram to inspect its declared settings.'
  for (const [element, field] of [['detail-pod', 'podId'], ['detail-role', 'role'], ['detail-runtime', 'runtime'], ['detail-model', 'model'], ['detail-reference', 'agentRef']]) $(element).textContent = node?.[field] || '—'
  for (const item of selectable()) item.classList.toggle('selected', nodeId(item) === selected)
}
function resize(next) {
  if (!svg) return
  scale = Math.max(.04, Math.min(4, next))
  svg.style.width = `${natural.width * scale}px`; svg.style.height = `${natural.height * scale}px`
}
function fit() {
  if (!svg) return
  resize(Math.min((viewport.clientWidth - 48) / natural.width, (viewport.clientHeight - 48) / natural.height, 1.4))
  viewport.scrollTo({ left: 0, top: 0 })
}
function clearGraph() {
  epoch++; model = null; svg = null; svgText = ''; diagram.replaceChildren(); details(null)
  $('empty').hidden = false; $('export').disabled = true; $('warnings').replaceChildren(); $('mermaid-source').value = ''
  $('rig-name').textContent = 'No valid topology'
  for (const id of ['pod-count', 'agent-count', 'edge-count']) $(id).textContent = '—'
}
function markDirty() {
  loadEpoch++; epoch++; dirty = true; $('export').disabled = true
  notice('Source changed · Render diagram to apply it. The map below is the previous snapshot.')
}
function scheduleRender() {
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
      svg.setAttribute('aria-label', `${current.name}: declared pods, agents and relationships`)
      for (const element of selectable()) {
        const node = current.nodes.find(n => n.uid === nodeId(element))
        if (!node) continue
        element.setAttribute('role', 'button'); element.setAttribute('tabindex', '0'); element.setAttribute('aria-label', `Inspect ${node.id}`)
        element.addEventListener('click', () => details(node))
        element.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); details(node) } })
      }
      details(current.nodes.find(n => n.uid === selected) || current.nodes[0]); fit()
      $('rig-name').textContent = current.name
      $('pod-count').textContent = current.pods.length; $('pod-noun').textContent = current.pods.length === 1 ? 'pod' : 'pods'; $('agent-count').textContent = current.nodes.length; $('edge-count').textContent = current.edges.length
      $('empty').hidden = true; $('error').hidden = true; $('mermaid-source').value = code
      $('warnings').replaceChildren(...current.warnings.map(message => { const li = document.createElement('li'); li.textContent = message; return li }))
      $('export').disabled = dirty; notice(dirty ? 'Source changed · The map is the previous snapshot. Render to apply the source.' : 'Ready · Declared topology only. Select an agent to inspect its settings.')
    } catch {
      if (revision !== epoch) return
      clearGraph(); $('error').textContent = 'The local renderer could not draw this projection. Simplify the diagram or shorten its labels; no agent operation was requested.'; $('error').hidden = false
      notice('Rendering failed. No source or diagram was uploaded.')
    }
  })
  return renderQueue
}
function renderSource() {
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
new ResizeObserver(() => {
  const preferred = innerWidth < 700 ? 'TB' : 'LR'
  if (!directionChosen && $('direction').value !== preferred) { $('direction').value = preferred; if (model) scheduleRender() }
  else if (svg) fit()
}).observe(document.querySelector('.map-card'))
adoptNativeTheme()
source.value = SAMPLE_TOPOLOGY
if (innerWidth < 700) $('direction').value = 'TB'
renderSource()
