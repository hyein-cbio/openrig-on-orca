import { canInstruct, instructionTextError } from './seat-instructions.mjs'
import { canStartSeat, canQueueTask, taskTextError } from './seat-tasks.mjs'
import { EXAMPLE_STEPS } from './example-story.mjs'
import { seatInPod, operationInstance } from './pods.mjs'

export const CONFIG_FIELDS = [
  ['root', 'Plugin data directory'], ['instanceHome', 'Existing OpenRig home override (empty = managed instance)'], ['daemonPort', 'Local daemon port'], ['nodePath', 'Node executable'],
  ['npmPath', 'npm executable'], ['rigPath', 'OpenRig executable'], ['tmuxPath', 'tmux executable'],
  ['extraPath', 'Additional executable directories'], ['homePath', 'Effective HOME override'],
  ['codexHome', 'Existing CODEX_HOME'], ['claudeConfigDir', 'Existing CLAUDE_CONFIG_DIR']
]
export const EMPTY_INPUT = { instructionSeat: '', instruction: '', taskSeat: '', summary: '', body: '', spec: '' }

/** One panel session. Navigation changes only local state; every write still uses the existing worker review contract. */
export function createPluginSession(request, changed = () => {}) {
  const state = { view: 'preparation', host: typeof request === 'function', env: null, draft: null, workspaceId: '',
    seats: null, inventory: null, inventorySource: 'tui', diagramSource: 'inventory', podKey: '', podError: '', examples: [], input: { ...EMPTY_INPUT }, plan: null, startupRisk: false, receipt: null,
    task: null, readOnly: true, busy: false, busyKind: null, error: '', notice: '', warning: '', step: 0 }
  const emit = () => changed(state)
  const dirty = () => JSON.stringify(state.draft) !== JSON.stringify(state.env?.config || null)
  function requireHost() { if (!state.host) throw new Error('Open this page inside the OpenRig for Orca plugin to use operations. The standalone preview is read-only.') }
  async function work(fn, kind = 'operation') {
    if (state.busy) return
    state.busy = true; state.busyKind = kind; state.error = ''; state.notice = ''; state.warning = ''; emit()
    try { requireHost(); await fn() } catch (error) { state.error = error instanceof Error ? error.message : String(error) }
    finally { state.busy = false; state.busyKind = null; emit() }
  }
  function invalidate() { state.plan = null; state.startupRisk = false }
  function apply(env) {
    if (state.task && JSON.stringify(state.env?.config) !== JSON.stringify(env.config)) state.task = { ...state.task, registration: 'unverified', state: 'unknown', detail: 'Instance configuration changed. Reconcile at the original endpoint before retrying.' }
    state.env = env; state.draft = { ...env.config }; state.seats = null; state.examples = []; state.inventory = null; state.diagramSource = 'inventory'; state.podKey = ''; state.podError = ''
    state.input.instructionSeat = ''; state.input.taskSeat = ''
    if (!env.workspaces.some(w => w.id === state.workspaceId)) state.workspaceId = ''
    invalidate()
  }
  const selectedPod = () => state.inventory?.pods.find(pod => pod.key === state.podKey) || null
  const podSeats = () => state.inventory?.seats.filter(seat => seatInPod(seat, selectedPod())) || []
  const podConnected = () => Boolean(selectedPod() && state.inventory?.connection.matchesConfigured && state.diagramSource === 'inventory')
  const findSeat = key => podSeats().find(seat => seat.key === key)
  async function loadPods(keepKey = '') {
    state.inventory = null; state.diagramSource = 'inventory'; state.podError = ''; state.podKey = ''; state.input.instructionSeat = ''; state.input.taskSeat = ''; invalidate(); emit()
    try {
      const inventory = await request('pods.list', { source: state.inventorySource }, { timeoutMs: 120000 })
      if (!Array.isArray(inventory?.pods) || !Array.isArray(inventory.seats) || typeof inventory.connection?.key !== 'string' || !/^[a-f0-9]{64}$/.test(inventory.connection.key)) throw new Error('Native pod observation is incomplete; no target was guessed.')
      state.inventory = inventory
      if (state.inventory.pods.some(pod => pod.key === keepKey)) state.podKey = keepKey
    } catch (error) { state.inventory = null; state.podError = error instanceof Error ? error.message : String(error) }
  }
  function canPrepare(action, extra = {}) {
    if (!state.host || state.busy || dirty() || !state.workspaceId || !state.env) return false
    const snapshot = state.env.snapshot, tools = snapshot.tools
    if (action === 'install-rig') return Boolean(tools.node && tools.npm)
    if (action === 'install-tmux') return true
    if (['install-claude', 'install-codex'].includes(action)) return Boolean(tools.node && tools.npm)
    if (action === 'login-claude') return Boolean(tools.claude)
    if (action === 'login-codex') return Boolean(tools.codex)
    if (['example-claude', 'example-codex'].includes(action)) return Boolean(tools.node)
    if (!snapshot.installed) return false
    if (action === 'console') return state.env.daemon?.status === 'reachable'
    if (action === 'start-daemon') return !state.env.config.instanceHome
    if (action === 'example-demo') return true
    if (action === 'launch-team') return Boolean(snapshot.ready && state.input.spec.trim())
    if (action === 'stop-example') return state.examples.some(e => e.id === extra.exampleId && e.kind === 'demo' && e.instance === operationInstance(state.env.config))
    if (action === 'launch-example') return Boolean(snapshot.ready && state.examples.some(e => e.id === extra.exampleId && e.kind !== 'demo'))
    if (action === 'launch-seat') return podConnected() && canStartSeat(findSeat(extra.seatKey))
    if (action === 'send-instruction') return podConnected() && canInstruct(findSeat(state.input.instructionSeat)) && !instructionTextError(state.input.instruction)
    if (action === 'create-task') return podConnected() && canQueueTask(findSeat(state.input.taskSeat)) && !taskTextError(state.input.summary, state.input.body)
    return false
  }
  const session = {
    state, dirty, canPrepare, selectedPod, podSeats, podConnected,
    setDiagramSource(source) {
      if (!['inventory', 'yaml'].includes(source) || state.diagramSource === source) return
      state.diagramSource = source; invalidate(); emit()
    },
    selectPod(key) {
      if (state.busy || (key && !state.inventory?.pods.some(pod => pod.key === key))) return false
      state.podKey = key; state.diagramSource = 'inventory'; state.input.instructionSeat = ''; state.input.taskSeat = ''; invalidate(); emit(); return true
    },
    async selectInventorySource(source) {
      if (!['tui', 'configured'].includes(source) || state.busy) return
      if (dirty()) { state.error = 'Save configuration before selecting another observed instance.'; emit(); return }
      state.inventorySource = source
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
      if (!['preparation', 'dashboard'].includes(view) || (state.busy && state.busyKind !== 'read')) return false
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
        if (['launch-seat', 'send-instruction', 'create-task'].includes(action)) Object.assign(input, { podKey: selectedPod().key, instanceKey: state.inventory.connection.key })
        if (action === 'send-instruction') Object.assign(input, { seatKey: state.input.instructionSeat, message: state.input.instruction })
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
        if (plan.queueTask) state.task = { id: plan.queueTask.id, destination: plan.queueTask.destination, registration: 'unverified', state: 'unknown', detail: 'Create requested. Reconcile this ID before retrying; an ID is not proof of persistence.' }
        const result = await request('setup.execute', { planId: plan.id, workspaceId: state.workspaceId, ...(plan.seatLaunch ? { acceptStartupRisk: state.startupRisk } : {}) })
        state.startupRisk = false
        if (result?.noOp === true) { state.notice = result.detail; return }
        if (typeof result?.terminalId !== 'string') throw new Error('No terminal receipt was returned. The outcome is unknown; inspect before retrying.')
        state.receipt = result
        if (result.task) state.task = result.task
        if (plan.instruction) { state.input.instruction = ''; state.input.instructionSeat = '' }
        if (plan.queueTask) { state.input.taskSeat = ''; state.input.summary = ''; state.input.body = '' }
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
      await work(async () => { if (state.receipt) state.receipt = await request('terminal.reveal', { terminalId: state.receipt.terminalId }) })
    },
    async checkTask() {
      await work(async () => {
        if (dirty()) throw new Error('Save configuration before checking registration.')
        if (state.task) state.task = await request('task.check', { id: state.task.id }, { timeoutMs: 120000 })
      }, 'read')
    }
  }
  return session
}
