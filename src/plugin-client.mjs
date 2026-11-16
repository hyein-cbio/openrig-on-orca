import { createPluginSession, CONFIG_FIELDS } from './plugin-state.mjs'
import { EXAMPLE_STEPS } from './example-story.mjs'
import { workspaceLabel, workspaceOptions } from './workspace-labels.mjs'
import { instructionTextError } from './seat-instructions.mjs'
import { canQueueTask, canStartSeat, managedAgent } from './seat-tasks.mjs'
import { watchPanelVisibility } from './refresh-loop.mjs'
import { displayPodSnapshot, observeTopologySource, setReportReader, updateObservationFreshness } from './topology-client.mjs'

const $ = id => document.getElementById(id)
const VIEWS = ['preparation', 'dashboard', 'messages']
const text = (id, value) => { $(id).textContent = value ?? '' }
const show = (id, visible) => { $(id).hidden = !visible }
function element(tag, value, className) {
  const node = document.createElement(tag)
  if (value !== undefined) node.textContent = value
  if (className) node.className = className
  return node
}
function list(id, values) { $(id).replaceChildren(...values.map(value => element('li', String(value)))) }
function inputValue(id, value) { if ($(id).value !== String(value ?? '')) $(id).value = value ?? '' }
function choices(id, items, value, placeholder) {
  const options = [Object.assign(document.createElement('option'), { value: '', textContent: placeholder })]
  for (const item of items) options.push(Object.assign(document.createElement('option'), { value: item.value, textContent: item.label, disabled: item.disabled === true }))
  $(id).replaceChildren(...options); $(id).value = value
}
const bridge = window.orca?.plugin?.request ? (name, input, options) => window.orca.plugin.request(name, input, options) : null
let ageTimer = null, disposed = false
const session = createPluginSession(bridge, render)
let renderedInventory, renderedPodKey, renderedDiagramSource, renderedRelations, renderedObservation, renderedUserReports, renderedReviewId
observeTopologySource(source => session.setDiagramSource(source))
setReportReader(key => session.readReport(key))
const inputBindings = { 'instruction-recipient': 'instructionSeat', 'instruction-text': 'instruction', 'task-recipient': 'taskSeat', 'task-summary': 'summary', 'task-body': 'body', 'team-spec': 'spec' }
for (const [id, key] of Object.entries(inputBindings)) $(id).addEventListener(['instruction-recipient', 'task-recipient'].includes(id) ? 'change' : 'input', event => session.editInput(key, event.target.value))
for (const [key, label] of CONFIG_FIELDS) {
  const field = element('div'), caption = element('label', label), input = document.createElement('input')
  input.id = `config-${key}`; input.maxLength = 4096; caption.htmlFor = input.id
  input.addEventListener('input', event => session.editConfig(key, event.target.value))
  field.append(caption, input); $('plugin-paths').append(field)
}
for (const view of VIEWS) {
  const tab = $(`view-${view}`)
  tab.addEventListener('click', () => session.switchView(view))
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? VIEWS[0] : event.key === 'End' ? VIEWS.at(-1) : VIEWS[(VIEWS.indexOf(view) + (event.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length]
    if (session.switchView(next)) $(`view-${next}`).focus()
  })
}
$('plugin-workspace').addEventListener('change', event => session.selectWorkspace(event.target.value))
$('plugin-provider').addEventListener('change', event => session.editConfig('provider', event.target.value))
$('seat-read-only').addEventListener('change', event => session.selectReadOnly(event.target.checked))
$('startup-risk').addEventListener('change', event => session.acknowledge(event.target.checked))
for (const button of document.querySelectorAll('[data-operation]')) button.addEventListener('click', () => session.prepare(button.dataset.operation, button.dataset.consoleSource ? { consoleSource: button.dataset.consoleSource } : {}))
$('scan-environment').addEventListener('click', session.scan)
$('save-provider').addEventListener('click', session.save)
$('save-paths').addEventListener('click', session.save)
$('go-dashboard').addEventListener('click', session.viewConfiguredDashboard)
$('view-configured-instance').addEventListener('click', session.viewConfiguredDashboard)
$('open-observed-tui').addEventListener('click', () => { const c = session.state.inventory?.connection; if (c) void session.prepare('console', { consoleSource: c.source, instanceKey: c.key }) })
$('refresh-seats').addEventListener('click', session.refreshPods)
$('refresh-pods').addEventListener('click', session.refreshPods)
$('auto-refresh').addEventListener('change', event => session.setAutoRefresh(event.target.checked))
$('dashboard-pod').addEventListener('change', event => { if (session.selectPod(event.target.value)) void session.refreshRelations() })
$('pod-instance-source').addEventListener('change', event => { void session.selectInventorySource(event.target.value) })
$('connect-pod-instance').addEventListener('click', session.connectInventory)
$('seat-start-connect').addEventListener('click', session.connectInventory)
$('messages-dashboard').addEventListener('click', () => session.switchView('dashboard'))
$('messages-refresh').addEventListener('click', session.refreshPods)
$('messages-connect').addEventListener('click', session.connectInventory)
$('reporting-seat').addEventListener('change', event => session.selectReportingSeat(event.target.value))
$('user-report-sources').addEventListener('input', event => session.editRequestSources(event.target.value))
$('load-user-reports').addEventListener('click', session.loadUserReports)
$('restore-pod-diagram').addEventListener('click', () => { $('yaml-tools').open = false; session.setDiagramSource('inventory') })
$('refresh-examples').addEventListener('click', session.refreshSeats)
$('confirm-operation').addEventListener('click', session.confirm)
$('cancel-operation').addEventListener('click', session.cancel)
$('reveal-terminal').addEventListener('click', session.reveal)
$('check-task').addEventListener('click', session.checkTask)
$('example-previous').addEventListener('click', () => session.step(-1))
$('example-next').addEventListener('click', () => session.step(1))
$('example-restart').addEventListener('click', () => session.step(-EXAMPLE_STEPS.length))
$('review-source').addEventListener('click', event => {
  if (window.orca?.shell?.openExternal) { event.preventDefault(); void window.orca.shell.openExternal(event.currentTarget.href).catch(() => {}) }
})
function actionButton(label, action, extra) {
  const button = element('button', label); button.type = 'button'; button.disabled = !session.canPrepare(action, extra)
  button.addEventListener('click', () => session.prepare(action, extra)); return button
}
function renderSeatStarts(state) {
  const pod = session.selectedPod(), rows = session.podSeats(), candidates = rows.filter(canStartSeat)
  show('pod-start-controls', Boolean(pod && !state.plan))
  if (!pod) { $('seat-start-list').replaceChildren(); return }
  text('seat-start-heading', `Start seats · ${pod.label}`)
  const reasons = []
  if (!state.host) reasons.push('Standalone preview: operations unavailable.')
  if (state.diagramSource !== 'inventory') reasons.push('Return to native pod inventory before starting a seat.')
  if (session.dirty()) reasons.push('Save configuration first.')
  if (state.observation.seatsError || state.observation.missing) reasons.push('Refresh the stale/unavailable native seat snapshot first.')
  const mismatch = !state.inventory.connection.matchesConfigured
  if (mismatch) reasons.push('Connect this observed instance for operations below.')
  if (!state.workspaceId) reasons.push('Choose the result terminal workspace below.')
  if (!state.env?.snapshot.installed) reasons.push('Verify Node, OpenRig, tmux and SQLite first.')
  if (state.busy || state.autoRefresh?.inFlight) reasons.push('Wait for the current operation or observation.')
  text('seat-start-status', `${candidates.length} registered seats support single-seat start review. ${reasons.join(' ')}`)
  show('seat-start-connection', mismatch)
  $('seat-start-connect').disabled = !state.host || state.busy || session.dirty() || Boolean(state.observation.seatsError)
  $('seat-start-list').replaceChildren(...rows.map(seat => {
    const row = element('div', undefined, 'seat-start-row')
    row.append(element('strong', seat.logicalId), element('small', `Recorded state: ${seat.status} · ${seat.runtime}`))
    if (canStartSeat(seat)) {
      const start = actionButton(`Review start · ${seat.logicalId}`, 'launch-seat', { seatKey: seat.key })
      start.classList.add('primary'); start.dataset.seatKey = seat.key; row.append(start)
    } else row.append(element('small', !managedAgent(seat) ? 'No GUI start: reserved/unknown seat or unsupported runtime.' : seat.attention || seat.lifecycle === 'attention_required' ? 'Attention is required; inspect the native TUI.' : seat.status === 'running' || seat.lifecycle === 'running' ? 'Already running; no restart is offered.' : 'This recorded state cannot be safely started from this control.'))
    return row
  }))
}
function renderSeats(state) {
  const pod = session.selectedPod(), rows = session.podSeats()
  text('selected-pod-heading', pod ? `${pod.label} · seat snapshot` : 'Selected pod seats · manual snapshot')
  if (!pod) { $('live-seats').replaceChildren(element('p', 'Select a verified native rig / pod. No example or workspace-derived target is substituted.')); return }
  if (!rows.length) { $('live-seats').replaceChildren(element('p', 'No seat observations were returned for this selected pod.')); return }
  $('live-seats').replaceChildren(...rows.map(seat => {
    const card = element('article', undefined, 'seat-card')
    card.append(element('h3', `${seat.rigName} / ${seat.logicalId}`), element('p', `Status summary: ${seat.status}${seat.attention ? ' · attention requested' : ''}`, 'seat-lifecycle'), element('p', `Activity: ${seat.activity} · Runtime: ${seat.runtime}`, 'seat-activity'), element('code', seat.session || 'No session yet'))
    const actions = element('div', undefined, 'toolbar'), attach = element('button', 'Open seat view'); attach.type = 'button'
    attach.disabled = state.busy || session.dirty() || !state.workspaceId || !session.podConnected() || seat.status !== 'running'
    attach.addEventListener('click', () => session.attach(seat.key))
    actions.append(actionButton('Review seat start', 'launch-seat', { seatKey: seat.key }), attach); card.append(actions); return card
  }))
}
function renderUserReports(state) {
  const pod = session.selectedPod(), reporting = session.reportingSeats().find(s => s.key === state.reportSeatKey), data = state.userReports
  choices('reporting-seat', session.reportingSeats().map(s => ({ value: s.key, label: `${s.rigName} / ${s.logicalId} · ${s.runtime}` })), state.reportSeatKey, 'Choose the reporting seat in this rig')
  $('reporting-seat').disabled = state.busy || !state.host || !pod
  inputValue('user-report-sources', state.requestSourceText); $('user-report-sources').disabled = state.busy || !state.host
  $('load-user-reports').disabled = state.busy || !state.host || session.dirty() || !reporting?.session || state.diagramSource !== 'inventory' || Boolean(state.observation.seatsError)
  text('user-report-context', pod ? `Rig: ${pod.rigName}${reporting ? ` · reporting seat: ${reporting.logicalId}` : ' · choose a reporting seat'}${reporting && !state.reportSeatPinned ? ' · topology-based default; confirm this is the seat you want' : ''}` : 'Select an actual native rig / pod to inspect its reports.')
  displayUserReportSnapshot(data, state.userReportError)
}
function displayUserReportSnapshot(data, error = '') {
  text('user-report-error', error); show('user-report-error', Boolean(error))
  text('user-report-status', data ? `${data.reports.length} stored resolution reports · ${error ? 'older retained snapshot' : data.status} · read ${new Date(data.observedAt).toLocaleString()}` : 'No report body has been read for this selection. Load stored reports explicitly.')
  list('user-report-notes', data?.notes || [])
  if (renderedUserReports === data) return
  renderedUserReports = data
  if (!data?.reports.length) { $('user-report-list').replaceChildren(element('p', data ? 'No stored resolution was found in the inspected windows, or the read is unverified. See provenance and limits; no report was generated.' : 'Stored user-request reports will appear here.')); return }
  $('user-report-list').replaceChildren(...data.reports.map(report => {
    const card = element('article', undefined, 'seat-card'), detail = element('details'), caption = element('summary', `Read stored resolution · ${report.bodyBytes} / ${report.totalBytes} UTF-8 bytes${report.truncated ? ' · truncated' : ''}`)
    card.append(element('h3', report.title), element('p', `Recorded task title${report.titleTruncated ? ' excerpt' : ''} · ${report.source} → ${data.reportingSeat}`), element('p', `Recorded task state: ${report.state} · updated ${new Date(report.updatedAt).toLocaleString()}`), element('code', `Source task: ${report.id}`), element('p', report.preview, 'report-preview'), element('small', `${new TextEncoder().encode(report.preview).length} / ${report.totalBytes} UTF-8-byte preview · expand the stored resolution below`))
    detail.append(caption, element('pre', report.body)); card.append(detail, element('small', 'Original request resolution, not an independent verification or proof of user delivery.'))
    return card
  }))
}
function renderMessages(state) {
  const pod = session.selectedPod(), connection = state.inventory?.connection, recipient = session.podSeats().find(s => s.key === state.input.instructionSeat), eligible = session.podSeats().filter(canQueueTask)
  text('messages-context', pod && connection ? `Native pod: ${pod.label}\nInstance: ${connection.endpoint}\nSeat snapshot: ${state.observation.seatsAt ? new Date(state.observation.seatsAt).toLocaleString() : 'unverified'}${recipient ? `\nRecipient: ${recipient.logicalId} · ${recipient.runtime} · ${recipient.status} / ${recipient.activity}` : ''}` : 'Choose an actual native rig / pod in Dashboard first. No recipient is inferred from the workspace or a seat name.')
  const reasons = []
  if (!pod) reasons.push('No pod selected.')
  if (state.diagramSource !== 'inventory') reasons.push('Return to native inventory in Dashboard; YAML preview is not a message target.')
  if (session.dirty()) reasons.push('Save configuration first.')
  if (state.observation.seatsError || state.observation.missing) reasons.push('Refresh the unavailable/stale native seat snapshot.')
  if (pod && !connection.matchesConfigured) reasons.push('Connect the observed instance for operations explicitly.')
  if (!state.workspaceId) reasons.push('Choose a result workspace for the send result.')
  if (pod && !eligible.length) reasons.push('No eligible running agent. Start or inspect seats in Dashboard; nothing is started here.')
  text('messages-status', reasons.length ? reasons.join(' ') : `${eligible.length} eligible running recipients. Select one and review the exact message; no send occurs on navigation.`)
  show('messages-routing', Boolean(pod && connection && !connection.matchesConfigured))
  $('messages-connect').disabled = !state.host || state.busy || session.dirty() || Boolean(state.observation.seatsError)
  $('messages-refresh').disabled = !state.host || state.busy || session.dirty() || !pod
  $('messages-dashboard').disabled = state.busy && state.busyKind !== 'read'
  const issue = !state.host ? 'Open this panel inside Orca.' : state.busy || state.autoRefresh?.inFlight ? 'Checking the current request…' : reasons[0] || (!state.env?.snapshot.installed ? 'Verify the environment in Preparation.' : !recipient ? 'Choose a running recipient.' : !canQueueTask(recipient) ? 'This seat is not ready to receive. Refresh recipients.' : instructionTextError(state.input.instruction))
  text('message-send-status', issue || 'Ready. Review the recipient and message.')
  $('message-send-status').classList.toggle('safety-note', Boolean(issue))
  document.querySelector('[data-operation="send-message"]').title = issue || 'Review this message'
}
function renderExamples(state) {
  const step = EXAMPLE_STEPS[state.step]
  text('example-step-count', `Step ${state.step + 1} of ${EXAMPLE_STEPS.length}`); text('example-step-title', step.title); text('example-speaker', step.speaker); text('example-step-text', step.text)
  $('example-previous').disabled = state.busy || state.step === 0; $('example-next').disabled = state.busy || state.step === EXAMPLE_STEPS.length - 1; $('example-restart').disabled = state.busy
  if (!state.examples.length) { $('example-records').replaceChildren(element('p', 'No recorded examples for this configured instance.')); return }
  $('example-records').replaceChildren(...state.examples.map(record => {
    const card = element('article', undefined, 'seat-card')
    card.append(element('h3', record.kind === 'demo' ? 'Terminal demo · simulation only' : `${record.kind} · real-agent template`), element('code', record.specPath))
    card.append(actionButton(record.kind === 'demo' ? 'Prepare stop demo' : 'Preview real team launch', record.kind === 'demo' ? 'stop-example' : 'launch-example', { exampleId: record.id }))
    for (const seat of (state.seats || []).filter(s => s.rigName === record.rigName)) {
      const button = element('button', `Open ${seat.logicalId} view`); button.type = 'button'
      button.disabled = state.busy || session.dirty() || !state.workspaceId || seat.status !== 'running'; button.addEventListener('click', () => session.attach(seat.key)); card.append(button)
    }
    return card
  }))
}
function renderReview(state) {
  const plan = state.plan
  show('plugin-review', Boolean(plan)); show('preparation-actions', !plan); show('dashboard-actions', !plan); show('messages-actions', !plan)
  if (!plan) { renderedReviewId = null; return }
  if (renderedReviewId !== plan.id) { $('review-effects').open = !plan.instruction; renderedReviewId = plan.id }
  text('review-title', plan.instruction ? 'Review message' : `Review · ${plan.title}`)
  text('review-intro', plan.instruction ? 'Check the recipient and message, then send. Review valid for 5 minutes.' : 'No execution has been requested. Launch preparation may have created a private frozen bundle. This one-use review expires after five minutes.')
  text('review-essential', plan.instruction ? `${plan.queueTask ? 'Creates a Native queue request. ' : ''}Sending may invoke a model and allow file edits.` : ''); show('review-essential', Boolean(plan.instruction))
  $('confirm-operation').textContent = plan.instruction ? 'Send message' : 'Confirm and open in Orca terminal'
  const target = state.env?.workspaces.find(w => w.id === plan.workspaceId)
  text('review-instance-detail', `${plan.pod ? `OpenRig pod: ${plan.pod.namespace || plan.pod.podId || '[unassigned]'} · rig ID ${plan.pod.rigId}\nInstance: ${plan.pod.endpoint}\n` : ''}Result terminal destination: ${workspaceLabel(target)} · ${target?.path || 'unavailable'}`)
  text('review-workspace', plan.instruction ? `${plan.pod ? `${plan.pod.namespace || plan.pod.podId || 'pod'} · ${plan.pod.endpoint}\n` : ''}Result: ${workspaceLabel(target)}` : $('review-instance-detail').textContent)
  let source
  try { source = new URL(plan.source); if (source.protocol !== 'https:') source = null } catch { source = null }
  show('review-source', Boolean(source)); if (source) $('review-source').href = source.href
  list('review-writes', plan.writes); list('review-warnings', plan.warnings); text('review-command', plan.command)
  text('review-declarations', plan.launchReview ? JSON.stringify(plan.launchReview.display, null, 2) : '')
  show('review-declarations', Boolean(plan.launchReview))
  show('review-response', Boolean(plan.instruction?.completion)); text('review-response-instructions', plan.instruction?.completion || '')
  let recipient = '', content = ''
  if (plan.console) { const c = plan.console; recipient = `TUI instance: ${c.source} · ${c.endpoint}\nOpenRig home: ${c.home}\nCLI: ${c.cli} · version ${c.version}\nNode: ${c.node}\nPrivate view socket directory: ${plan.consoleRuntime}\nView only: no daemon, kernel or agent startup is requested.` }
  if (plan.instruction) { recipient = `Agent: ${plan.instruction.session} · ${plan.instruction.runtime}`; content = plan.instruction.text }
  if (plan.seatLaunch) { const seat = plan.seatLaunch; recipient = `Registered seat: ${seat.rigId} / ${seat.logicalId}\nRuntime: ${seat.runtime}\nModel: ${seat.model || 'UNVERIFIED native selection'}\nCwd: ${seat.cwd || 'UNVERIFIED native seat cwd'}` }
  if (plan.queueTask) { const task = plan.queueTask; recipient = `Request ID: ${task.id}\nSource: orca-gui@external\nDestination: ${task.destination}\nTitle: ${task.summary}`; content = plan.instruction ? plan.instruction.text : task.body }
  text('review-target', recipient); text('review-content', content); show('review-target', Boolean(recipient)); show('review-content', Boolean(content))
  show('startup-consent', Boolean(plan.seatLaunch)); $('startup-risk').checked = state.startupRisk; $('startup-risk').disabled = state.busy
  $('confirm-operation').disabled = state.busy || session.dirty() || Boolean(plan.seatLaunch && !state.startupRisk)
  $('cancel-operation').disabled = state.busy
}
function renderObservationStatus(state) {
  const current = session.observationStatus(), auto = state.autoRefresh, stamp = value => value ? new Date(value).toLocaleString() : 'No successful read'
  $('auto-refresh').checked = auto.enabled; $('auto-refresh').disabled = !state.host
  text('auto-refresh-status', !auto.enabled ? 'Off · observations are manual snapshots.' : auto.inFlight ? 'Refreshing read-only observations…' : auto.paused ? `Paused · ${auto.paused}` : `Next read: ${stamp(auto.nextAt)} · ${auto.failures ? `${2 ** auto.failures}-minute failure backoff` : '1-minute interval'}`)
  text('observation-times', `Last successful seats: ${stamp(current.seatsAt)} · complete relationships: ${stamp(current.relationsAt)}`)
  const stale = Boolean(state.podKey && (current.seatsStale || current.relationsStale))
  show('observation-stale', stale)
  text('observation-stale', `${current.seatsStale ? 'Seats are stale/unverified. ' : ''}${current.relationsStale ? 'Relationships are stale/incomplete. ' : ''}${current.seatsError || current.relationsError || 'Data at least one minute old is not confirmed current state.'}`)
  if (state.diagramSource === 'inventory') updateObservationFreshness(current)
}
function render(state) {
  const env = state.env, snapshot = env?.snapshot, dirty = session.dirty(), waiting = state.busy, hosted = state.host
  for (const view of VIEWS) {
    const selected = state.view === view, tab = $(`view-${view}`)
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; tab.disabled = waiting && state.busyKind !== 'read'
    show(`${view}-view`, selected)
  }
  show('plugin-preview', !hosted); show('plugin-progress', waiting)
  for (const [id, message] of [['plugin-error', state.error], ['plugin-notice', state.notice], ['plugin-warning', state.warning]]) { text(id, message); show(id, Boolean(message)) }
  show('plugin-dirty', dirty)
  const destination = $('workspace-destination-control'), destinationHost = $(state.view === 'messages' ? 'messages-destination' : state.view === 'dashboard' ? session.selectedPod() ? 'seat-start-destination' : 'dashboard-destination' : 'preparation-destination')
  show('dashboard-terminal-destination', !session.selectedPod())
  if (destination.parentElement !== destinationHost) destinationHost.append(destination)
  text('plugin-workspace-label', state.view === 'messages' ? 'Workspace for send result (required)' : 'Result terminal destination · Orca workspace')
  choices('plugin-workspace', workspaceOptions(env?.workspaces || []), state.workspaceId, state.view === 'messages' ? 'Required: choose result workspace' : 'Choose only when an operation needs a terminal'); $('plugin-workspace').disabled = waiting || !env
  choices('dashboard-pod', (state.inventory?.pods || []).map(pod => ({ value: pod.key, label: `${pod.label} · ${pod.seatCount} seats` })), state.podKey, state.inventory ? 'Choose an actual OpenRig rig / pod' : 'No verified native pod inventory')
  $('dashboard-pod').disabled = waiting || !state.inventory || dirty
  $('refresh-pods').disabled = !hosted || waiting || dirty || !env
  inputValue('pod-instance-source', state.inventorySource); $('pod-instance-source').disabled = !hosted || waiting || dirty
  text('pod-error', state.podError); show('pod-error', Boolean(state.podError))
  const connection = state.inventory?.connection
  $('open-observed-tui').disabled = !connection || !session.canPrepare('console', { consoleSource: connection.source, instanceKey: connection.key })
  $('view-configured-instance').disabled = !hosted || waiting || dirty || !env
  text('pod-connection', connection ? `${connection.source === 'tui' ? 'Default local TUI' : 'Plugin-configured'} instance: ${connection.endpoint}\nOpenRig home: ${connection.home}` : 'No verified instance observation. Nothing was started, and no other endpoint was silently queried.')
  const guidance = state.diagramSource === 'yaml' ? 'YAML declaration preview active; return to pod inventory before operations.' : session.selectedPod() ? connection?.matchesConfigured ? 'Choose a result terminal destination only to use operations.' : 'Read-only observation; explicitly connect this instance before operations.' : 'Select one pod; an Orca workspace is not an OpenRig target.'
  text('pod-observation', state.inventory ? `${state.inventory.pods.length} pods observed at ${new Date(state.inventory.observedAt).toLocaleString()}. ${guidance}` : 'Refresh native pods to inspect the TUI inventory. Unavailable is not an empty list.')
  show('pod-connect-review', Boolean(connection && !connection.matchesConfigured)); $('connect-pod-instance').disabled = waiting || dirty || !hosted || !connection
  show('declaration-mode-note', state.diagramSource === 'yaml')
  const observationKey = JSON.stringify([state.inventory?.observedAt, state.relations?.observedAt, state.observation])
  if (state.diagramSource === 'inventory' && (renderedInventory !== state.inventory || renderedPodKey !== state.podKey || renderedDiagramSource !== state.diagramSource || renderedRelations !== state.relations || renderedObservation !== observationKey)) { renderedInventory = state.inventory; renderedPodKey = state.podKey; renderedDiagramSource = state.diagramSource; renderedRelations = state.relations; renderedObservation = observationKey; displayPodSnapshot(session.selectedPod(), session.podSeats(), state.inventory?.observedAt, state.relations, session.observationStatus(), connection?.key) }
  renderedDiagramSource = state.diagramSource
  renderObservationStatus(state)
  text('environment-stage', snapshot ? snapshot.stage.replaceAll('-', ' ') : hosted ? 'Checking environment…' : 'Read-only visual preview; no plugin host.')
  const tools = snapshot ? [['Node', snapshot.tools.node || 'Compatible runtime needed'], ['OpenRig', snapshot.rigVersion || 'Not installed'], ['tmux', snapshot.tmuxVersion || 'Required — unavailable'], ['SQLite', `${snapshot.sqlite.status}: ${snapshot.sqlite.detail}`]] : []
  $('environment-tools').replaceChildren(...tools.flatMap(([name, value]) => [element('dt', name), element('dd', value)]))
  $('scan-environment').disabled = !hosted || waiting || dirty
  for (const [key] of CONFIG_FIELDS) { inputValue(`config-${key}`, state.draft?.[key]); $(`config-${key}`).disabled = !state.draft || waiting }
  inputValue('plugin-provider', state.draft?.provider || 'none'); $('plugin-provider').disabled = !state.draft || waiting
  $('save-provider').disabled = $('save-paths').disabled = !hosted || waiting || !dirty
  show('claude-actions', ['claude', 'both'].includes(state.draft?.provider)); show('codex-actions', ['codex', 'both'].includes(state.draft?.provider))
  text('provider-status', snapshot?.providers.map(p => `${p.provider}: ${p.status}`).join(' · ') || 'No coding agent is required for initial setup or the declared topology viewer.')
  const daemon = `Daemon: ${env?.daemon?.status || 'not checked'}. ${env?.daemon?.detail || 'Use a read-only environment check to inspect this configured instance.'}`
  text('daemon-state', daemon)
  text('configured-instance', env ? `Plugin operation routing: ${env.config.instanceHome || `${env.config.root}/instance`} · http://127.0.0.1:${env.config.daemonPort}\nCLI: ${snapshot?.tools.rig || 'unavailable'} · ${snapshot?.rigVersion || 'unverified version'}${env.config.instanceHome ? ' · existing instance; managed daemon start is disabled' : ''}` : '')
  text('dashboard-daemon', connection ? `${connection.endpoint} · ${connection.matchesConfigured ? 'Operations route to this instance' : 'Operations locked: plugin connection differs'}` : 'No verified pod inventory.')
  $('go-dashboard').disabled = !hosted || waiting || dirty || !env
  $('refresh-seats').disabled = !hosted || waiting || dirty || !env
  $('refresh-examples').disabled = !hosted || waiting || dirty || !snapshot?.installed
  $('seat-read-only').checked = state.readOnly; $('seat-read-only').disabled = waiting
  choices('instruction-recipient', session.podSeats().map(s => ({ value: s.key, label: `${s.rigName} / ${s.logicalId} · ${s.runtime} · ${s.activity}`, disabled: !canQueueTask(s) })), state.input.instructionSeat, 'Choose one existing running agent')
  choices('task-recipient', session.podSeats().map(s => ({ value: s.key, label: `${s.rigName} / ${s.logicalId} · ${s.runtime}`, disabled: !canQueueTask(s) })), state.input.taskSeat, 'Choose one existing running agent')
  for (const [id, key] of Object.entries(inputBindings)) { if (!id.endsWith('recipient')) inputValue(id, state.input[key]); $(id).disabled = waiting || dirty || !hosted }
  for (const button of document.querySelectorAll('[data-operation]')) button.disabled = !session.canPrepare(button.dataset.operation, button.dataset.consoleSource ? { consoleSource: button.dataset.consoleSource } : {})
  renderSeatStarts(state); renderSeats(state); renderUserReports(state); renderMessages(state); renderExamples(state); renderReview(state)
  show('plugin-receipt', Boolean(state.receipt && !state.plan))
  if (state.receipt) {
    const receipt = state.receipt
    text('receipt-summary', `${receipt.title || 'Existing result'} · ${receipt.workspaceName || receipt.workspaceId || 'workspace'} · ${receipt.terminalId}\nVisibility: ${receipt.visibility || 'unverified'}. ${receipt.visibilityDetail || 'Inspect the terminal before interpreting the operation result.'}`)
    text('receipt-warning', receipt.warning || 'A terminal receipt is not proof of delivery, startup, acknowledgment or completion.')
    text('receipt-recovery', receipt.recoveryCommand || 'Use Reveal existing result terminal; do not repeat the original action.')
  }
  $('reveal-terminal').disabled = waiting || !hosted
  show('plugin-task', Boolean(state.task && !state.plan))
  if (state.task) { text('task-id', state.task.id); text('task-state', `Destination: ${state.task.destination} · Registration: ${state.task.registration} · Recorded state: ${state.task.state}`); text('task-detail', state.task.detail) }
  const reply = state.task?.registration === 'verified' ? state.task.resolution : null
  show('task-resolution-card', Boolean(reply)); text('task-resolution', reply?.body || ''); text('task-resolution-meta', reply ? `Stored resolution · ${reply.bytes} / ${reply.totalBytes} UTF-8 bytes${reply.truncated ? ' · truncated' : ''}` : '')
  $('check-task').disabled = waiting || dirty || !hosted
  syncAgeClock()
}
render(session.state)
function syncAgeClock() {
  if (ageTimer !== null) { clearTimeout(ageTimer); ageTimer = null }
  if (disposed || !session.state.autoRefresh.visible || session.state.view !== 'dashboard') return
  renderObservationStatus(session.state)
  ageTimer = setTimeout(syncAgeClock, 15000) // Labels only; never a worker request or DAG redraw.
}
const visibility = watchPanelVisibility({ document, window, IntersectionObserver: window.IntersectionObserver, changed: (visible, known) => session.setPanelVisibility(visible, known) })
window.addEventListener('pagehide', () => { if (ageTimer !== null) clearTimeout(ageTimer); ageTimer = null })
window.addEventListener('beforeunload', () => { disposed = true; visibility.dispose(); session.dispose(); if (ageTimer !== null) clearTimeout(ageTimer) })
if (bridge) void session.scan()
export { watchPanelVisibility, displayUserReportSnapshot }
