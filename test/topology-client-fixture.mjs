import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { podsFromSeats } from '../src/pods.mjs'

// Execute the actual browser controller with isolated DOM/renderer doubles. Only
// SVG parsing/layout and sanitization are doubled; graph, navigation, events,
// render queue, metadata and export code are the production implementation.
// Keep the production loader strict: a normal Node child builds the test-only doubles.
const compiled = promisify(execFile)(process.execPath, [fileURLToPath(new URL('./compile-topology-fixture.mjs', import.meta.url))], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 30000, maxBuffer: 4 * 1024 * 1024
}).then(result => result.stdout)
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
class Element {
  constructor(localName = 'div', id = '') {
    this.localName = localName; this.id = id; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.classes = new Set()
    this.classList = { contains: key => this.classes.has(key), remove: key => this.classes.delete(key),
      toggle: (key, value = !this.classes.has(key)) => value ? this.classes.add(key) : this.classes.delete(key) }
    this.style = { setProperty(key, value) { this[key] = value } }
    this.hidden = false; this.disabled = false; this.value = ''; this.text = ''; this.isConnected = true
    this.clientWidth = 800; this.clientHeight = 440; this.scrollLeft = 0; this.scrollTop = 0
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join('') }
  set textContent(value) { this.text = String(value); this.children = [] }
  setAttribute(key, value) { this.attributes.set(key, String(value)) }
  getAttribute(key) { return this.attributes.get(key) ?? null }
  removeAttribute(key) { this.attributes.delete(key) }
  addEventListener(name, listener) { const listeners = this.listeners.get(name) || []; listeners.push(listener); this.listeners.set(name, listeners) }
  fire(type, key) { return (this.listeners.get(type) || []).map(listener => listener({ type, key, preventDefault() {}, target: this })) }
  click() { if (!this.disabled) return this.fire('click') }
  focus() { this.fire('focus') }
  scrollTo({ left, top }) { this.scrollLeft = Math.max(0, left); this.scrollTop = Math.max(0, top) }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 60, width: 100, height: 60 } }
  replaceChildren(...children) { this.children.forEach(child => { child.isConnected = false }); this.children = children; this.text = '' }
  prepend(...children) { this.children.unshift(...children) }
  append(...children) { this.children.push(...children) }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(selector === 'g.node' ? child.localName === 'g' && child.classes.has('node') ? [child] : [] : child.localName === selector ? [child] : []),
      ...child.querySelectorAll(selector)
    ])
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  cloneNode(deep) {
    const copy = new Element(this.localName, this.id)
    copy.text = this.text; copy.attributes = new Map(this.attributes); copy.classes = new Set(this.classes); Object.assign(copy.style, this.style)
    copy.viewBox = this.viewBox
    if (deep) copy.children = this.children.map(child => child.cloneNode(true))
    return copy
  }
  get outerHTML() {
    const attrs = [...this.attributes].map(([key, value]) => ` ${key}="${escape(value)}"`).join('')
    return `<${this.localName}${attrs}>${escape(this.text)}${this.children.map(child => child.outerHTML).join('')}</${this.localName}>`
  }
}

export async function topologyClientFixture() {
  const html = await readFile(new URL('../src/topology.html', import.meta.url), 'utf8')
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element('div', id)]))
  elements.set('dashboard-pod', new Element()); elements.get('direction').value = 'LR'
  const document = { getElementById: id => elements.get(id) || null, querySelector: () => new Element(), documentElement: new Element(),
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), importNode: root => root.cloneNode(true) }
  const themeListeners = new Map(), exported = [], renderCalls = []
  const window = { addEventListener() {}, orca: { on: (name, callback) => themeListeners.set(name, callback),
    files: { saveAs: async value => { exported.push(value); return { status: 'cancelled' } } } } }
  let gate = null, resizeViewportListener = null
  const mermaid = { initialize() {}, async render(id, code) {
    const paused = gate; gate = null; renderCalls.push({ id, code })
    if (paused) { paused.started.resolve(); await paused.released.promise }
    return { svg: code }
  } }
  class DOMParser {
    parseFromString(code) {
      const root = new Element('svg'); root.viewBox = { baseVal: { width: 600, height: 350 } }
      root.children = [...code.matchAll(/^(agent_\d+)\[/gm)].map(([, uid], i) => {
        const node = new Element('g', `flowchart-${uid}-${i}`); node.classes.add('node'); return node
      })
      return { documentElement: root, querySelector: () => null }
    }
  }
  const module = { exports: {} }
  runInNewContext(await compiled, { module, document, window, __mermaid: mermaid, __purify: { sanitize: value => value }, DOMParser,
    getComputedStyle: () => ({ getPropertyValue: () => '' }), CSS: { supports: () => false },
    matchMedia: () => ({ matches: false, addEventListener() {} }), ResizeObserver: class { constructor(listener) { resizeViewportListener = listener } observe() {} },
    innerWidth: 1200, innerHeight: 900, TextEncoder, TextDecoder, console }, { filename: 'topology-client-fixture.cjs' })
  const ids = ['root', 'hub', ...Array.from({ length: 7 }, (_, i) => `worker${i}`)]
  const seats = ids.map(id => ({ key: JSON.stringify(['rig-fixture', id]), rigId: 'rig-fixture', rigName: 'Fixture', logicalId: id,
    podId: 'pod-fixture', podNamespace: 'fixture', runtime: 'pi', model: 'fixture-model', status: 'running', activity: 'idle', attention: false }))
  const pod = podsFromSeats(seats)[0], key = id => seats.find(seat => seat.logicalId === id).key
  const relations = { podKey: pod.key, observedAt: 1000, status: 'complete', notes: [], edges: [
    { fromKey: key('root'), toKey: key('hub'), kind: 'delegates_to' },
    ...ids.slice(2).map(id => ({ fromKey: key('hub'), toKey: key(id), kind: 'delegates_to' }))
  ] }
  return {
    element: id => elements.get(id),
    resizeViewport(width, height) { const viewport = elements.get('viewport'); viewport.clientWidth = width; viewport.clientHeight = height; resizeViewportListener() },
    get svg() { return elements.get('diagram').querySelector('svg') },
    get nodes() { return elements.get('diagram').querySelectorAll('g.node') },
    exported, renderCalls, seats, relations,
    piExportAction(action, available) { module.exports.setPiExportAction(action, available) },
    observe({ members = seats, status = 'complete', notes = [], stamp = 1000, instance = 'fixture-instance' } = {}) {
      module.exports.displayPodSnapshot(pod, members, stamp, { ...relations, status, notes, observedAt: stamp }, null, instance)
    },
    theme() { themeListeners.get('theme')() },
    pauseNextRender() {
      const started = defer(), released = defer(); gate = { started, released }
      return { started: started.promise, release: () => released.resolve() }
    },
    flush: () => new Promise(resolve => setImmediate(resolve))
  }
}
