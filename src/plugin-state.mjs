import { canInstruct, instructionTextError } from './seat-instructions.mjs'
import { canStartSeat, canQueueTask, canExportPiSeat, taskTextError } from './seat-tasks.mjs'
import { EXAMPLE_STEPS } from './example-story.mjs'
import { createRefreshLoop, REFRESH_MS } from './refresh-loop.mjs'
import { DEFAULT_REQUEST_SOURCES, reportingSeatDefault, requestSources } from './user-report-projection.mjs'
import { reportPrefix } from './report-preview.mjs'
import { seatInPod, operationInstance } from './pods.mjs'

export const CONFIG_FIELDS = [
  ['root', 'Plugin data directory'], ['instanceHome', 'Existing OpenRig home override (empty = managed instance)'], ['daemonPort', 'Local daemon port'], ['nodePath', 'Node executable'],
  ['npmPath', 'npm executable'], ['rigPath', 'OpenRig executable'], ['tmuxPath', 'tmux executable'],
  ['extraPath', 'Additional executable directories'], ['homePath', 'Effective HOME override'],
  ['codexHome', 'Existing CODEX_HOME'], ['claudeConfigDir', 'Existing CLAUDE_CONFIG_DIR']
]
export const EMPTY_INPUT = { instructionSeat: '', instruction: '', taskSeat: '', summary: '', body: '', spec: '' }

/** One panel session. Navigation never writes; opted-in visible observations may resume reads. Every write retains the worker review contract. */
export function createPluginSession(request, changed = () => {}, options = {}) {
  const now = options.clock?.now || Date.now
  const emptyObservation = () => ({ seatsAt: 0, relationsAt: 0, lastSuccessAt: 0, seatsError: '', relationsError: '', missing: false, identityChanged: false })
  const state = { view: 'preparation', host: typeof request === 'function', env: null, draft: null, workspaceId: '',
    seats: null, inventory: null, relations: null, inventorySource: 'tui', daemonTarget: null, tuiPort: '', checkedTuiPort: '', tuiPortEditable: false, daemonCheckError: '', diagramSource: 'inventory', podKey: '', podError: '', examples: [], input: { ...EMPTY_INPUT }, plan: null, startupRisk: false, receipt: null,
    reportSeatKey: '', reportSeatPinned: false, requestSourceText: DEFAULT_REQUEST_SOURCES.join(', '), userReports: null, userReportError: '',
    observation: emptyObservation(), autoRefresh: null, task: null, piHtml: null, readOnly: true, busy: false, busyKind: null, error: '', notice: '', warning: '', step: 0 }
  const reportCache = new Map(); let reportReads = 0, refreshLoop = null, disposed = false
  const emit = () => { if (!disposed) { refreshLoop?.sync(); changed(state) } }
  const inventoryKey = value => value && JSON.stringify({ ...value, observedAt: 0 })
  const relationsKey = value => value && JSON.stringify({ ...value, observedAt: 0, memberKeys: [...value.memberKeys].sort(), edges: [...value.edges].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) })
  const validInventory = value => Array.isArray(value?.pods) && Array.isArray(value.seats) && typeof value.connection?.key === 'string' && /^[a-f0-9]{64}$/.test(value.connection.key)
  const validRelations = (value, instanceKey, podKey) => value?.instanceKey === instanceKey && value.podKey === podKey && ['complete', 'partial', 'unavailable'].includes(value.status) && Array.isArray(value.memberKeys) && Array.isArray(value.edges) && value.edges.length <= 160 && Array.isArray(value.notes)
  const dirty = () => JSON.stringify(state.draft) !== JSON.stringify(state.env?.config || null)
  function requireHost() { if (!state.host) throw new Error('Open this page inside the OpenRig for Orca plugin to use operations. The standalone preview is read-only.') }
  async function work(fn, kind = 'operation') {
    if (disposed || state.busy) return
    refreshLoop?.cancel()
    state.busy = true; state.busyKind = kind; state.error = ''; state.notice = ''; state.warning = ''; emit()
    try { requireHost(); await fn() } catch (error) { if (!disposed) state.error = error instanceof Error ? error.message : String(error) }
    finally { state.busy = false; state.busyKind = null; emit() }
  }
  function invalidate() { state.plan = null; state.startupRisk = false }
  function apply(env) {
    reportCache.clear(); state.observation = emptyObservation(); state.reportSeatKey = ''; state.reportSeatPinned = false; state.userReports = null; state.userReportError = ''
    if (state.task && JSON.stringify(state.env?.config) !== JSON.stringify(env.config)) state.task = { ...state.task, registration: 'unverified', state: 'unknown', resolution: undefined, detail: 'Instance configuration changed. Reconcile at the original endpoint before retrying.' }
    state.env = env; state.draft = { ...env.config }; state.seats = null; state.examples = []; state.inventory = null; state.relations = null; state.daemonTarget = null; state.tuiPort = ''; state.checkedTuiPort = ''; state.tuiPortEditable = false; state.daemonCheckError = ''; state.diagramSource = 'inventory'; state.podKey = ''; state.podError = ''
    state.input.instructionSeat = ''; state.input.taskSeat = ''
    if (!env.workspaces.some(w => w.id === state.workspaceId)) state.workspaceId = ''
    invalidate()
  }
  const selectedPod = () => state.inventory?.pods.find(pod => pod.key === state.podKey) || null
  const podSeats = () => state.inventory?.seats.filter(seat => seatInPod(seat, selectedPod())) || []
  const podConnected = () => Boolean(selectedPod() && state.inventory?.connection.matchesConfigured && state.diagramSource === 'inventory' && !state.observation.seatsError && !state.observation.missing)
  const findSeat = key => podSeats().find(seat => seat.key === key)
  function storeInventory(next) {
    if (inventoryKey(next) === inventoryKey(state.inventory)) state.inventory.observedAt = next.observedAt
    else state.inventory = next
  }
  function recordFullSuccess() {
    const o = state.observation
    if (o.seatsAt && o.relationsAt && !o.seatsError && !o.relationsError && state.relations?.status === 'complete') {
      o.lastSuccessAt = Math.min(o.seatsAt, o.relationsAt); refreshLoop?.success(o.lastSuccessAt)
    }
  }
  function storeRelations(result, memberKeys) {
    const different = JSON.stringify([...result.memberKeys].sort()) !== JSON.stringify([...memberKeys].sort())
    const next = different ? { ...result, status: 'partial', notes: [...result.notes, 'Membership changed while loading relationships. Refresh the pod snapshot; unmatched endpoints are not drawn.'] } : result
    if (next.status === 'unavailable' && state.relations?.podKey === next.podKey && state.relations?.instanceKey === next.instanceKey && state.relations.status !== 'loading') {
      state.observation.relationsError = 'Relationship lookup unavailable; showing the previous relationship snapshot.'; return
    }
    if (relationsKey(next) === relationsKey(state.relations)) state.relations.observedAt = next.observedAt
    else state.relations = next
    state.observation.relationsError = next.status === 'complete' ? '' : 'Relationship observation is partial or unverified.'
    if (next.status === 'complete') state.observation.relationsAt = now()
  }
  const reportingSeats = () => state.inventory?.seats.filter(s => s.rigId === selectedPod()?.rigId) || []
  function syncReportingSeat() {
    if (state.reportSeatKey && !reportingSeats().some(s => s.key === state.reportSeatKey)) { state.reportSeatKey = ''; state.userReports = null; state.userReportError = 'Reporting seat changed or disappeared. Choose it explicitly before another report read.'; return }
    if (!state.reportSeatKey && !state.reportSeatPinned) state.reportSeatKey = reportingSeatDefault(state.inventory, selectedPod(), state.relations)
  }
  const tuiPortDraftChanged = () => state.inventorySource === 'tui' && state.tuiPortEditable && state.tuiPort !== state.checkedTuiPort
  const tuiPortNeedsCheck = () => tuiPortDraftChanged() || (state.inventorySource === 'tui' && state.tuiPortEditable && Boolean(state.inventory && String(Number(state.checkedTuiPort)) !== state.inventory.connection.port))
  const selectedReachable = () => Boolean(state.inventory?.connection.source === state.inventorySource && !state.observation.seatsError && !tuiPortNeedsCheck())
  const matchesSelectedDaemon = () => state.daemonTarget?.source === state.inventorySource && !tuiPortDraftChanged()
  function daemonStartReason() {
    if (!state.host) return 'Open this panel inside Orca.'
    if (state.busy || state.autoRefresh?.inFlight) return 'Wait for the current operation or observation.'
    if (dirty()) return 'Save configuration before reviewing a start.'
    if (!state.env?.snapshot.installed) return 'Verify Node, OpenRig, tmux and SQLite first.'
    if (selectedReachable()) return 'The selected instance is reachable. No restart is offered.'
    if (state.daemonCheckError || !matchesSelectedDaemon()) return state.daemonCheckError || 'Check the selected instance and port before reviewing a start.'
    if (state.daemonTarget.status !== 'startable') return state.daemonTarget.detail
    if (!state.workspaceId) return 'Choose a local Orca workspace for the result terminal.'
    return ''
  }
  async function inspectSelectedInstance() {
    const source = state.inventorySource, port = state.tuiPort
    state.daemonCheckError = ''
    try {
      const target = await request('instance.inspect', { source, ...(source === 'tui' && port ? { tuiPort: port } : {}) })
      if (disposed) return
      if (target?.source !== source || !/^[a-f0-9]{64}$/.test(target.key) || !['startable', 'port-required', 'blocked'].includes(target.status)) throw new Error('Unexpected instance metadata')
      state.daemonTarget = target; state.checkedTuiPort = port; state.tuiPortEditable = source === 'tui' && target.portRequired === true
    } catch {
      if (disposed) return
      // Keep a previously shown port field editable without reusing its old review key.
      if (source === 'tui' && state.tuiPortEditable) state.checkedTuiPort = null
      else state.daemonTarget = null
      state.daemonCheckError = 'Could not check the selected instance. Try Check instance before starting.'
    }
  }
  async function loadPods(keepKey = '') {
    reportCache.clear()
    const previous = state.inventory, previousPod = state.podKey
    state.diagramSource = 'inventory'; state.podError = ''; invalidate(); emit()
    // Let the latest native inventory read determine reachability after the startup check.
    await inspectSelectedInstance()
    if (disposed) return
    try {
      const inventory = await request('pods.list', { source: state.inventorySource }, { timeoutMs: 120000 })
      if (!validInventory(inventory)) throw new Error('Native pod observation is incomplete; no target was guessed.')
      const sameInstance = !previous || previous.connection.key === inventory.connection.key
      storeInventory(inventory)
      state.observation.seatsAt = now(); state.observation.seatsError = ''; state.observation.missing = false; state.observation.identityChanged = false
      state.podKey = sameInstance && inventory.pods.some(p => p.key === keepKey) ? keepKey : ''
      if (state.podKey !== previousPod || !sameInstance) { state.relations = null; state.observation.relationsAt = 0; state.observation.relationsError = ''; state.observation.lastSuccessAt = 0; reportCache.clear(); state.reportSeatKey = ''; state.reportSeatPinned = false; state.userReports = null; state.userReportError = '' }
      if (!podSeats().some(s => s.key === state.input.instructionSeat)) state.input.instructionSeat = ''
      if (!podSeats().some(s => s.key === state.input.taskSeat)) state.input.taskSeat = ''
      if (state.podKey) await loadRelations()
    } catch (error) {
      state.podError = error instanceof Error ? error.message : String(error)
      state.observation.seatsError = 'Seat lookup failed; the retained snapshot is stale, not current state.'; refreshLoop?.failure()
    }
  }
  async function loadRelations() {
    const pod = selectedPod(), inventory = state.inventory
    if (!pod || !inventory) { state.relations = null; return }
    const { key: instanceKey, source } = inventory.connection, podKey = pod.key, memberKeys = podSeats().map(s => s.key)
    const same = () => state.inventory?.connection.key === instanceKey && state.podKey === podKey
    syncReportingSeat()
    if (!state.relations) state.relations = { instanceKey, podKey, memberKeys, observedAt: 0, status: 'loading', edges: [], notes: ['Reading native compact relationship metadata…'] }
    emit()
    try {
      const result = await request('pods.edges', { source: source || state.inventorySource, instanceKey, podKey }, { timeoutMs: 120000 })
      if (!same()) return
      if (!validRelations(result, instanceKey, podKey)) throw new Error('Invalid relationship observation')
      storeRelations(result, memberKeys); syncReportingSeat(); if (state.observation.relationsError) refreshLoop?.failure(); else recordFullSuccess()
    } catch {
      if (same()) {
        state.observation.relationsError = 'Relationship lookup failed; any retained lines are from an older snapshot.'; refreshLoop?.failure()
        if (!state.relations || state.relations.status === 'loading') state.relations = { instanceKey, podKey, memberKeys, observedAt: 0, status: 'unavailable', edges: [], notes: ['Relationship observation unavailable. Missing lines are unverified, not proof that no connection exists.'] }
      }
    }
  }
  async function observeSelected(signal) {
    const pod = selectedPod(), original = state.inventory
    if (!pod || !original) return false
    const instanceKey = original.connection.key, podKey = pod.key, source = original.connection.source || state.inventorySource
    const current = () => !signal.aborted && state.podKey === podKey && state.inventory?.connection.key === instanceKey && state.view === 'dashboard' && state.diagramSource === 'inventory' && !state.plan && !state.busy && !dirty()
    let next
    try {
      next = await request('pods.list', { source }, { timeoutMs: 120000, signal })
      if (!current()) return false
      if (!validInventory(next)) throw new Error('Invalid inventory')
      if (next.connection.key !== instanceKey) { state.observation.identityChanged = true; throw new Error('Instance changed') }
      if (!next.pods.some(p => p.key === podKey)) { state.observation.missing = true; throw new Error('Selected pod missing') }
    } catch {
      if (current()) { if (state.observation.identityChanged || state.observation.missing) { state.userReports = null; state.reportSeatKey = ''; state.reportSeatPinned = true; state.userReportError = 'The observed rig/instance context changed or disappeared. Inspect it manually before another report read.' } state.observation.seatsError = state.observation.identityChanged ? 'Instance changed. Auto refresh is paused; inspect and refresh manually.' : state.observation.missing ? 'The selected pod was not returned. Its previous snapshot is stale; no other pod was selected.' : 'Automatic seat lookup failed. Showing the last successful snapshot, not current state.'; state.podError = state.observation.seatsError }
      return false
    }
    let result
    try { result = await request('pods.edges', { source, instanceKey, podKey }, { timeoutMs: 120000, signal }) } catch { /* Preserve last-good relationships independently. */ }
    if (!current()) return false
    const selected = next.pods.find(p => p.key === podKey), members = next.seats.filter(s => seatInPod(s, selected)), memberKeys = members.map(s => s.key)
    const definition = seats => JSON.stringify(seats.map(s => [s.key, s.session, s.runtime, s.model]))
    if (definition(members) !== definition(podSeats())) reportCache.clear()
    storeInventory(next); state.observation.seatsAt = now(); state.observation.seatsError = ''; state.observation.missing = false; state.podError = ''
    if (!members.some(s => s.key === state.input.instructionSeat)) state.input.instructionSeat = ''
    if (!members.some(s => s.key === state.input.taskSeat)) state.input.taskSeat = ''
    if (validRelations(result, instanceKey, podKey)) storeRelations(result, memberKeys)
    else state.observation.relationsError = 'Automatic relationship lookup failed. Showing the older relationship snapshot, not current connections.'
    syncReportingSeat()
    const ok = !state.observation.relationsError && state.relations?.status === 'complete'
    if (ok) state.observation.lastSuccessAt = Math.min(state.observation.seatsAt, state.observation.relationsAt)
    return ok
  }
  function canPrepare(action, extra = {}) {
    if (disposed || !state.host || state.busy || state.autoRefresh?.inFlight || dirty() || !state.workspaceId || !state.env) return false
    const snapshot = state.env.snapshot, tools = snapshot.tools
    if (action === 'install-rig') return Boolean(tools.node && tools.npm)
    if (action === 'install-tmux') return true
    if (['install-claude', 'install-codex'].includes(action)) return Boolean(tools.node && tools.npm)
    if (action === 'login-claude') return Boolean(tools.claude)
    if (action === 'login-codex') return Boolean(tools.codex)
    if (['example-claude', 'example-codex'].includes(action)) return Boolean(tools.node)
    if (!snapshot.installed) return false
    if (action === 'console') {
      // The Preparation control does not belong to the Dashboard's YAML preview. Both bind the checked instance key.
      if (extra.instanceKey !== undefined) return selectedReachable() && extra.instanceKey === state.inventory.connection.key && extra.consoleSource === state.inventorySource && (state.view === 'preparation' || state.diagramSource === 'inventory')
      return (!extra.consoleSource || extra.consoleSource === 'configured') && state.env.daemon?.status === 'reachable'
    }
    if (action === 'start-daemon') return !daemonStartReason()
    if (action === 'example-demo') return true
    if (action === 'launch-team') return Boolean(snapshot.ready && state.input.spec.trim())
    if (action === 'stop-example') return state.examples.some(e => e.id === extra.exampleId && e.kind === 'demo' && e.instance === operationInstance(state.env.config))
    if (action === 'launch-example') return Boolean(snapshot.ready && state.examples.some(e => e.id === extra.exampleId && e.kind !== 'demo'))
    if (action === 'export-pi-html') return Boolean(selectedPod() && state.diagramSource === 'inventory' && !state.observation.seatsError && !state.observation.missing && canExportPiSeat(findSeat(extra.seatKey)))
    if (action === 'launch-seat') return podConnected() && canStartSeat(findSeat(extra.seatKey))
    if (action === 'send-message') return podConnected() && canQueueTask(findSeat(state.input.instructionSeat)) && !instructionTextError(state.input.instruction)
    if (action === 'send-instruction') return podConnected() && canInstruct(findSeat(state.input.instructionSeat)) && !instructionTextError(state.input.instruction)
    if (action === 'create-task') return podConnected() && canQueueTask(findSeat(state.input.taskSeat)) && !taskTextError(state.input.summary, state.input.body)
    return false
  }
  const session = {
    state, dirty, canPrepare, daemonStartReason, selectedReachable, tuiPortNeedsCheck, tuiPortDraftChanged, selectedPod, podSeats, podConnected, reportingSeats,
    editTuiPort(value) {
      if (state.busy || state.inventorySource !== 'tui' || !state.tuiPortEditable) return
      state.tuiPort = String(value).slice(0, 5); state.daemonCheckError = ''; invalidate(); emit()
    },
    selectReportingSeat(key) {
      if (state.busy || (key && !reportingSeats().some(s => s.key === key))) return false
      state.reportSeatKey = key; state.reportSeatPinned = true; state.userReports = null; state.userReportError = ''; emit(); return true
    },
    editRequestSources(text) {
      if (state.busy) return
      state.requestSourceText = String(text).slice(0, 1000); state.userReports = null; state.userReportError = ''; emit()
    },
    async loadUserReports() {
      await work(async () => {
        if (dirty() || !state.inventory || !selectedPod() || state.diagramSource !== 'inventory' || state.observation.seatsError) throw new Error('Refresh a saved native rig/pod before reading user reports.')
        const seat = reportingSeats().find(s => s.key === state.reportSeatKey)
        if (!seat) throw new Error('Choose the reporting seat. Its name alone is not treated as a lead role.')
        state.reportSeatPinned = true
        const sources = requestSources(state.requestSourceText), instanceKey = state.inventory.connection.key, podKey = state.podKey, seatKey = seat.key
        state.userReportError = ''
        try {
          const result = await request('user.reports', { source: state.inventory.connection.source || state.inventorySource, instanceKey, podKey, seatKey, sources }, { timeoutMs: 120000 })
          if (disposed) return
          if (state.inventory?.connection.key !== instanceKey || state.podKey !== podKey || state.reportSeatKey !== seatKey || result?.instanceKey !== instanceKey || result.podKey !== podKey || result.seatKey !== seatKey || result.rigId !== seat.rigId || JSON.stringify(result.sources) !== JSON.stringify(sources) || !['ready', 'partial', 'unverified'].includes(result.status) || !Array.isArray(result.reports) || result.reports.length > 10 || !Array.isArray(result.notes)) throw new Error('The report context changed or returned incomplete data.')
          if (result.reports.some(r => typeof r.body !== 'string' || new TextEncoder().encode(r.body).length > 16384 || typeof r.preview !== 'string' || new TextEncoder().encode(r.preview).length > 500 || !sources.includes(r.source))) throw new Error('A report exceeded its bounded source/body projection.')
          if (result.status === 'unverified' && state.userReports?.reports.length) state.userReportError = 'Native report reads are unverified. The last successful report snapshot is retained; its original read time still applies.'
          else state.userReports = result
        } catch { state.userReportError = 'User report read failed or changed context. Any retained cards are an older report snapshot; no report was generated.' }
      }, 'read')
    },
    setAutoRefresh(value) { refreshLoop.setEnabled(value) },
    setPanelVisibility(visible, known = true) { refreshLoop.setVisibility(visible, known) },
    observationStatus() {
      const o = state.observation
      return { ...o, seatsStale: !o.seatsAt || Boolean(o.seatsError) || now() - o.seatsAt >= REFRESH_MS,
        relationsStale: !o.relationsAt || Boolean(o.relationsError) || state.relations?.status !== 'complete' || now() - o.relationsAt >= REFRESH_MS }
    },
    tickObservationClock() { emit() },
    dispose() { disposed = true; refreshLoop.dispose(); reportCache.clear(); state.userReports = null; state.reportSeatKey = ''; state.task = null; state.piHtml = null; invalidate() },
    setDiagramSource(source) {
      if (!['inventory', 'yaml'].includes(source) || state.diagramSource === source) return
      state.diagramSource = source; invalidate(); emit()
    },
    selectPod(key) {
      if (state.busy || (key && !state.inventory?.pods.some(pod => pod.key === key))) return false
      state.reportSeatKey = ''; state.reportSeatPinned = false; state.userReports = null; state.userReportError = ''; reportCache.clear(); state.podKey = key; state.relations = null; state.observation = { ...state.observation, relationsAt: 0, relationsError: '', lastSuccessAt: 0, missing: false }; state.diagramSource = 'inventory'; state.input.instructionSeat = ''; state.input.taskSeat = ''; invalidate(); emit(); return true
    },
    async readReport(seatKey) {
      const inventory = state.inventory, pod = selectedPod(), seat = podSeats().find(s => s.key === seatKey)
      const base = { instanceKey: inventory?.connection.key || '', podKey: pod?.key || '', seatKey, observedAt: Date.now() }
      const unknown = detail => ({ ...base, status: 'unverified', detail })
      if (disposed || !state.host || !inventory || !pod || !seat || dirty() || state.observation.seatsError || state.diagramSource !== 'inventory') return unknown('Preview unavailable for this saved native pod. No YAML or terminal output was used.')
      const cached = reportCache.get(seatKey)
      if (cached && Date.now() < cached.expires) return cached.promise
      if (reportReads >= 2) return unknown('Other report previews are loading. Hover or focus this seat again shortly.')
      const promise = (async () => {
        reportReads++
        try {
          const result = await request('seat.report', { source: inventory.connection.source || state.inventorySource, instanceKey: base.instanceKey, podKey: base.podKey, seatKey }, { timeoutMs: 45000 })
          if (disposed || state.inventory?.connection.key !== base.instanceKey || state.podKey !== pod.key || !podSeats().some(s => s.key === seat.key && s.session === seat.session && s.runtime === seat.runtime) || dirty() || state.diagramSource !== 'inventory') return unknown('Pod context changed; hover again after refreshing.')
          if (result?.instanceKey !== base.instanceKey || result.podKey !== base.podKey || result.seatKey !== seatKey || !['recorded', 'none', 'unverified'].includes(result.status)) throw new Error('Invalid report preview')
          const metadata = { ...base, observedAt: result.observedAt, status: result.status, detail: String(result.detail || '').slice(0, 700) }
          if (result.status !== 'recorded') return metadata
          const prefix = reportPrefix(result.preview)
          if (prefix.truncated || !Number.isSafeInteger(result.totalBytes) || result.totalBytes < prefix.previewBytes) throw new Error('Invalid preview byte budget')
          return { ...metadata, preview: prefix.preview, previewBytes: prefix.previewBytes, totalBytes: result.totalBytes, truncated: result.truncated === true,
            recordId: String(result.recordId || '').slice(0, 200), recordedAt: String(result.recordedAt || '').slice(0, 80), recipient: String(result.recipient || '').slice(0, 300), delivery: String(result.delivery || 'unknown').slice(0, 40), kind: String(result.kind || 'Recorded outbound message').slice(0, 80) }
        } catch { return unknown('Native outbox preview unavailable. No report was inferred from terminal output or a task title.') }
        finally { reportReads-- }
      })()
      const entry = { promise, expires: Infinity }; reportCache.set(seatKey, entry)
      promise.then(result => {
        if (reportCache.get(seatKey) !== entry) return
        const ttl = result.status === 'recorded' ? 30000 : 5000; entry.expires = Date.now() + ttl
        const timer = setTimeout(() => { if (reportCache.get(seatKey) === entry) reportCache.delete(seatKey) }, ttl)
        timer.unref?.() // Node tests need not stay alive; browsers return a numeric timer handle.
      })
      return promise
    },
    async refreshRelations() {
      await work(async () => { if (dirty()) throw new Error('Save configuration before reading relationships.'); await loadRelations() }, 'read')
    },
    async selectInventorySource(source) {
      if (!['tui', 'configured'].includes(source) || state.busy) return
      if (dirty()) { state.error = 'Save configuration before selecting another observed instance.'; emit(); return }
      if (state.inventorySource === source) return
      state.inventorySource = source; state.daemonTarget = null; state.daemonCheckError = ''; state.inventory = null; state.relations = null; state.podKey = ''; state.observation = emptyObservation(); state.reportSeatKey = ''; state.reportSeatPinned = false; state.userReports = null; state.userReportError = ''; reportCache.clear()
      state.input.instructionSeat = ''; state.input.taskSeat = ''
      await session.refreshPods(false)
    },
    async refreshPods(keep = true) {
      await work(async () => {
        if (dirty()) throw new Error('Save configuration before reading another instance.')
        await loadPods(keep ? state.podKey : '')
      }, 'read')
    },
    async connectInventory() {
      await work(async () => {
        if (dirty() || !state.inventory) throw new Error('Save configuration and refresh the observed instance first.')
        const key = state.podKey, connection = state.inventory.connection
        apply(await request('pods.connect', { source: connection.source, expectedKey: connection.key }))
        await loadPods(key)
        state.notice = 'Plugin routing now uses the explicitly observed instance. No native settings, daemon, kernel or agent was started or changed.'
      })
    },
    switchView(view) {
      if (!['preparation', 'dashboard', 'messages'].includes(view) || (state.busy && state.busyKind !== 'read')) return false
      if (state.view !== view) { state.view = view; invalidate(); emit() }
      return true
    },
    selectWorkspace(id) { if (state.busy) return; state.workspaceId = id; invalidate(); emit() },
    selectReadOnly(value) { if (!state.busy) { state.readOnly = value === true; emit() } },
    editConfig(key, value) {
      if (state.busy || !state.draft || !['provider', ...CONFIG_FIELDS.map(([name]) => name)].includes(key)) return
      state.draft = { ...state.draft, [key]: value }; invalidate(); emit()
    },
    editInput(key, value) { if (state.busy || !Object.hasOwn(EMPTY_INPUT, key)) return; state.input[key] = value; invalidate(); emit() },
    acknowledge(value) { if (!state.busy) { state.startupRisk = value === true; emit() } },
    cancel() { if (!state.busy) { invalidate(); emit() } },
    step(delta) { state.step = Math.min(EXAMPLE_STEPS.length - 1, Math.max(0, state.step + delta)); emit() },
    async scan() {
      await work(async () => {
        if (dirty()) throw new Error('Save configuration before rechecking the environment.')
        const keepKey = state.podKey
        apply(await request('environment.scan'))
        try { state.examples = (await request('examples.list')).examples }
        catch { state.warning = 'Environment checked, but example records could not be read. No action was retried.' }
        await loadPods(keepKey)
      }, 'read')
    },
    async save() {
      await work(async () => {
        if (!state.draft) throw new Error('Check the environment first.')
        apply(await request('config.save', { ...state.draft }))
        state.notice = 'Configuration saved. No installation, login or agent launch was requested.'
        try { state.examples = (await request('examples.list')).examples } catch { state.warning = 'Example records could not be refreshed.' }
        await loadPods()
      })
    },
    viewSelectedDashboard() { if (!session.switchView('dashboard')) return false; session.setDiagramSource('inventory'); return true },
    async refreshSeats() {
      await work(async () => {
        if (dirty()) throw new Error('Save configuration before reading seats from another instance.')
        invalidate(); state.seats = null; state.input.instructionSeat = ''; state.input.taskSeat = ''
        state.seats = (await request('seats.list')).seats
      }, 'read')
    },
    async prepare(action, extra = {}) {
      if (!canPrepare(action, extra)) { state.error = 'This action is unavailable. Check its target, input, saved configuration and prerequisites.'; emit(); return }
      await work(async () => {
        invalidate()
        const input = { action, workspaceId: state.workspaceId, spec: state.input.spec, ...extra }
        if (['launch-seat', 'send-instruction', 'send-message', 'create-task', 'export-pi-html'].includes(action)) Object.assign(input, { podKey: selectedPod().key, instanceKey: state.inventory.connection.key })
        if (action === 'send-instruction' || action === 'send-message') Object.assign(input, { seatKey: state.input.instructionSeat, message: state.input.instruction })
        if (action === 'export-pi-html') input.exportSource = state.inventory.connection.source
        if (action === 'start-daemon') {
          Object.assign(input, { daemonSource: state.inventorySource, daemonKey: state.daemonTarget.key })
          if (state.inventorySource === 'tui' && state.tuiPort) input.tuiPort = state.tuiPort
        }
        if (action === 'create-task') Object.assign(input, { seatKey: state.input.taskSeat, summary: state.input.summary, body: state.input.body })
        state.plan = await request('setup.prepare', input, { timeoutMs: 120000 })
      })
    },
    async confirm() {
      const plan = state.plan
      if (!plan || state.busy) return
      if (dirty() || plan.workspaceId !== state.workspaceId || plan.expires <= Date.now()) { invalidate(); state.error = 'The review expired or its destination/configuration changed. Prepare a new review.'; emit(); return }
      if (plan.seatLaunch && !state.startupRisk) { state.error = 'Acknowledge unverified native startup settings before confirming.'; emit(); return }
      await work(async () => {
        state.plan = null // Consume the visible review before the potentially ambiguous operation. Never auto-retry.
        if (plan.action === 'start-daemon') { state.daemonTarget = null; state.checkedTuiPort = null; state.daemonCheckError = 'Check the selected instance after inspecting the result terminal. Do not repeat an unverified start.' }
        if (plan.queueTask) state.task = { id: plan.queueTask.id, destination: plan.queueTask.destination, registration: 'unverified', state: 'unknown', detail: 'Create requested. Reconcile this ID before retrying; an ID is not proof of persistence.' }
        const result = await request('setup.execute', { planId: plan.id, workspaceId: state.workspaceId, ...(plan.seatLaunch ? { acceptStartupRisk: state.startupRisk } : {}) })
        state.startupRisk = false
        if (result?.kind === 'pi-html') { if (!disposed) { state.piHtml = result; state.notice = result.detail }; return }
        if (result?.noOp === true) { state.notice = result.detail; return }
        if (typeof result?.terminalId !== 'string') throw new Error('No terminal receipt was returned. The outcome is unknown; inspect before retrying.')
        state.receipt = result
        if (result.task) state.task = result.task
        if (plan.instruction) { state.input.instruction = ''; state.input.instructionSeat = '' }
        if (plan.action === 'create-task') { state.input.taskSeat = ''; state.input.summary = ''; state.input.body = '' }
        state.notice = 'A result terminal was created. Its creation is not proof of command success, startup or completion.'
        if (plan.example) {
          try { state.examples = (await request('examples.list')).examples }
          catch { state.warning = 'The result terminal was already created, but refreshing example records failed. Inspect it; do not repeat the action.' }
        }
      })
    },
    async attach(key) {
      await work(async () => {
        const dashboard = state.view === 'dashboard'
        const seat = dashboard ? findSeat(key) : state.seats?.find(row => row.key === key)
        if (dirty() || !state.workspaceId || seat?.status !== 'running' || (dashboard && !podConnected())) throw new Error('Choose a running seat and a local destination in the saved instance.')
        state.receipt = await request('seat.attach', { key, workspaceId: state.workspaceId, readOnly: state.readOnly, ...(dashboard ? { podKey: selectedPod().key, instanceKey: state.inventory.connection.key } : {}) })
        state.notice = `${state.readOnly ? 'A read-only' : 'A writable'} seat view was created. Closing it detaches; it does not stop the seat. View mode does not restrict agent tools.`
      })
    },
    async reveal() {
      const receipt = state.receipt
      if (!receipt) return
      await work(async () => {
        let result
        try { result = await request('terminal.reveal', { terminalId: receipt.terminalId }) }
        catch { /* A closed tab or unavailable worker may reject instead of returning an unverified receipt. */ }
        if (disposed || state.receipt !== receipt) return
        if (result?.terminalId === receipt.terminalId && result.visibility === 'shown') {
          state.receipt = result
        } else {
          state.receipt = null
          state.notice = 'Could not show the result terminal. No command was repeated.'
        }
      })
    },
    async openPiHtml() {
      await work(async () => {
        if (state.piHtml) { const receipt = await request('pi-html.open', { id: state.piHtml.id }, { timeoutMs: 120000 }); if (!disposed) state.piHtml = receipt }
      })
    },
    async checkTask() {
      await work(async () => {
        if (dirty()) throw new Error('Save configuration before checking registration.')
        if (state.task) {
          const previous = state.task, next = await request('task.check', { id: previous.id }, { timeoutMs: 120000 })
          // A closed panel must neither retain replies nor accept a late readback.
          if (disposed || state.task !== previous) return
          if (next?.id !== previous.id || next.destination !== previous.destination || !['verified', 'unverified'].includes(next.registration)) throw new Error('The request readback changed identity.')
          const reply = next.resolution
          if (reply && (next.registration !== 'verified' || typeof reply.body !== 'string' || new TextEncoder().encode(reply.body).length > 16384 || reply.bytes !== new TextEncoder().encode(reply.body).length || !Number.isSafeInteger(reply.totalBytes) || reply.totalBytes < reply.bytes || typeof reply.truncated !== 'boolean')) throw new Error('The stored reply exceeded its bounded projection.')
          state.task = next
        }
      }, 'read')
    }
  }
  refreshLoop = createRefreshLoop({ run: observeSelected, context: () => state.inventory && state.podKey ? JSON.stringify([state.inventory.connection.key, state.podKey, state.inventorySource]) : '',
    blocked: () => !state.host ? 'Standalone preview' : state.view !== 'dashboard' ? 'Dashboard not selected' : state.diagramSource !== 'inventory' ? 'YAML preview' : state.plan ? 'Operation review open' : state.busy ? 'Another operation or read is running' : dirty() ? 'Unsaved configuration' : state.observation.identityChanged ? 'Instance changed; refresh manually' : '',
    lastSuccess: () => state.observation.lastSuccessAt, changed: () => changed(state), clock: options.clock })
  state.autoRefresh = refreshLoop.state
  return session
}
