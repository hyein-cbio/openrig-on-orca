import { createPluginSession, CONFIG_FIELDS } from './plugin-state.mjs'
import { EXAMPLE_STEPS } from './example-story.mjs'
import { workspaceLabel, workspaceOptions } from './workspace-labels.mjs'
import { canInstruct } from './seat-instructions.mjs'
import { canQueueTask } from './seat-tasks.mjs'

const $ = id => document.getElementById(id)
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
const session = createPluginSession(bridge, render)
const inputBindings = { 'instruction-recipient': 'instructionSeat', 'instruction-text': 'instruction', 'task-recipient': 'taskSeat', 'task-summary': 'summary', 'task-body': 'body', 'team-spec': 'spec' }
for (const [id, key] of Object.entries(inputBindings)) $(id).addEventListener(['instruction-recipient', 'task-recipient'].includes(id) ? 'change' : 'input', event => session.editInput(key, event.target.value))
for (const [key, label] of CONFIG_FIELDS) {
  const field = element('div'), caption = element('label', label), input = document.createElement('input')
  input.id = `config-${key}`; input.maxLength = 4096; caption.htmlFor = input.id
  input.addEventListener('input', event => session.editConfig(key, event.target.value))
  field.append(caption, input); $('plugin-paths').append(field)
}
for (const view of ['preparation', 'dashboard']) {
  const tab = $(`view-${view}`)
  tab.addEventListener('click', () => session.switchView(view))
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 'preparation' : event.key === 'End' ? 'dashboard' : view === 'preparation' ? 'dashboard' : 'preparation'
    if (session.switchView(next)) $(`view-${next}`).focus()
  })
}
$('plugin-workspace').addEventListener('change', event => session.selectWorkspace(event.target.value))
$('plugin-provider').addEventListener('change', event => session.editConfig('provider', event.target.value))
$('seat-read-only').addEventListener('change', event => session.selectReadOnly(event.target.checked))
$('startup-risk').addEventListener('change', event => session.acknowledge(event.target.checked))
for (const button of document.querySelectorAll('[data-operation]')) button.addEventListener('click', () => session.prepare(button.dataset.operation))
$('scan-environment').addEventListener('click', session.scan)
$('save-provider').addEventListener('click', session.save)
$('save-paths').addEventListener('click', session.save)
$('go-dashboard').addEventListener('click', () => session.switchView('dashboard'))
$('refresh-seats').addEventListener('click', session.refreshSeats)
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
function renderSeats(state) {
  const rows = state.seats
  if (rows === null) { $('live-seats').replaceChildren(element('p', 'Refresh to read the configured instance. Nothing was started or restarted.')); return }
  if (!rows.length) { $('live-seats').replaceChildren(element('p', 'No registered seats were returned by this instance.')); return }
  $('live-seats').replaceChildren(...rows.map(seat => {
    const card = element('article', undefined, 'seat-card')
    card.append(element('h3', `${seat.rigName} / ${seat.logicalId}`), element('p', `Lifecycle: ${seat.status}${seat.attention ? ' · attention requested' : ''}`, 'seat-lifecycle'), element('p', `Activity: ${seat.activity} · Runtime: ${seat.runtime}`, 'seat-activity'), element('code', seat.session || 'No session yet'))
    const actions = element('div', undefined, 'toolbar'), attach = element('button', 'Open seat view'); attach.type = 'button'
    attach.disabled = state.busy || session.dirty() || !state.workspaceId || seat.status !== 'running'
    attach.addEventListener('click', () => session.attach(seat.key))
    actions.append(actionButton('Review seat start', 'launch-seat', { seatKey: seat.key }), attach); card.append(actions); return card
  }))
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
  show('plugin-review', Boolean(plan)); show('preparation-actions', !plan); show('dashboard-actions', !plan)
  if (!plan) return
  text('review-title', `Review · ${plan.title}`)
  const target = state.env?.workspaces.find(w => w.id === plan.workspaceId)
  text('review-workspace', `Destination: ${workspaceLabel(target)} · ${target?.path || 'unavailable'}`)
  let source
  try { source = new URL(plan.source); if (source.protocol !== 'https:') source = null } catch { source = null }
  show('review-source', Boolean(source)); if (source) $('review-source').href = source.href
  list('review-writes', plan.writes); list('review-warnings', plan.warnings); text('review-command', plan.command)
  text('review-declarations', plan.launchReview ? JSON.stringify(plan.launchReview.display, null, 2) : '')
  show('review-declarations', Boolean(plan.launchReview))
  let recipient = '', content = ''
  if (plan.instruction) { recipient = `Agent: ${plan.instruction.session} · ${plan.instruction.runtime}`; content = plan.instruction.text }
  if (plan.seatLaunch) { const seat = plan.seatLaunch; recipient = `Registered seat: ${seat.rigId} / ${seat.logicalId}\nRuntime: ${seat.runtime}\nModel: ${seat.model || 'UNVERIFIED native selection'}\nCwd: ${seat.cwd || 'UNVERIFIED native seat cwd'}` }
  if (plan.queueTask) { const task = plan.queueTask; recipient = `Request ID (not proof of registration): ${task.id}\nDestination: ${task.destination}\nTitle: ${task.summary}`; content = task.body }
  text('review-target', recipient); text('review-content', content); show('review-target', Boolean(recipient)); show('review-content', Boolean(content))
  show('startup-consent', Boolean(plan.seatLaunch)); $('startup-risk').checked = state.startupRisk; $('startup-risk').disabled = state.busy
  $('confirm-operation').disabled = state.busy || session.dirty() || Boolean(plan.seatLaunch && !state.startupRisk)
  $('cancel-operation').disabled = state.busy
}
function render(state) {
  const env = state.env, snapshot = env?.snapshot, dirty = session.dirty(), waiting = state.busy, hosted = state.host
  for (const view of ['preparation', 'dashboard']) {
    const selected = state.view === view, tab = $(`view-${view}`)
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; tab.disabled = waiting && state.busyKind !== 'read'
    show(`${view}-view`, selected)
  }
  show('plugin-preview', !hosted); show('plugin-progress', waiting)
  for (const [id, message] of [['plugin-error', state.error], ['plugin-notice', state.notice], ['plugin-warning', state.warning]]) { text(id, message); show(id, Boolean(message)) }
  show('plugin-dirty', dirty)
  choices('plugin-workspace', workspaceOptions(env?.workspaces || []), state.workspaceId, 'Choose a local workspace'); $('plugin-workspace').disabled = waiting || !env
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
  text('daemon-state', daemon); text('dashboard-daemon', daemon)
  $('go-dashboard').disabled = waiting && state.busyKind !== 'read'
  $('refresh-seats').disabled = $('refresh-examples').disabled = !hosted || waiting || dirty || !snapshot?.installed
  $('seat-read-only').checked = state.readOnly; $('seat-read-only').disabled = waiting
  choices('instruction-recipient', (state.seats || []).map(s => ({ value: s.key, label: `${s.rigName} / ${s.logicalId} · ${s.runtime} · ${s.activity}`, disabled: !canInstruct(s) })), state.input.instructionSeat, 'Choose one existing idle agent')
  choices('task-recipient', (state.seats || []).map(s => ({ value: s.key, label: `${s.rigName} / ${s.logicalId} · ${s.runtime}`, disabled: !canQueueTask(s) })), state.input.taskSeat, 'Choose one existing running agent')
  for (const [id, key] of Object.entries(inputBindings)) { if (!id.endsWith('recipient')) inputValue(id, state.input[key]); $(id).disabled = waiting || dirty || !hosted }
  for (const button of document.querySelectorAll('[data-operation]')) button.disabled = !session.canPrepare(button.dataset.operation)
  renderSeats(state); renderExamples(state); renderReview(state)
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
  $('check-task').disabled = waiting || dirty || !hosted
}
render(session.state)
if (bridge) void session.scan()
