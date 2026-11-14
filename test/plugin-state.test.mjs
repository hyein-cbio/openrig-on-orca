import test from 'node:test'
import assert from 'node:assert/strict'
import { createPluginSession } from '../src/plugin-state.mjs'

const env = { config: { provider: 'none', root: '/fixture/data', daemonPort: '43811' },
  workspaces: [{ id: 'work', name: 'Fixture', path: '/fixture/project', hostId: 'local' }],
  snapshot: { installed: true, ready: true, stage: 'ready', tools: { node: '/fixture/node', npm: '/fixture/npm', rig: '/fixture/rig', tmux: '/fixture/tmux', claude: '/fixture/claude', codex: '/fixture/codex' }, providers: [], sqlite: { status: 'verified', detail: 'Fixture' } },
  daemon: { status: 'reachable', detail: 'Fixture endpoint' } }
const seat = { key: '["rig-1","dev.worker"]', rigId: 'rig-1', rigName: 'demo', logicalId: 'dev.worker', session: 'dev-worker@demo', runtime: 'pi', status: 'running', activity: 'idle', attention: false }
function fixture(overrides = {}) {
  const calls = []
  const handlers = { 'environment.scan': () => structuredClone(env), 'examples.list': () => ({ examples: [] }), 'seats.list': () => ({ seats: [structuredClone(seat)] }), ...overrides }
  const session = createPluginSession(async (name, input, options) => { calls.push({ name, input, options }); if (!handlers[name]) throw new Error(`Unexpected request: ${name}`); return handlers[name](input) })
  return { session, state: session.state, calls }
}
const plan = extra => ({ id: 'plan-fixture', workspaceId: 'work', expires: Date.now() + 60000, title: 'Fixture', command: 'never executed here', source: 'https://example.invalid', writes: [], warnings: [], ...extra })
async function ready(f) { await f.session.scan(); f.session.selectWorkspace('work') }

test('one session has exactly preparation/dashboard navigation with no execution or extra requests', async () => {
  const f = fixture(); await ready(f)
  assert.equal(f.state.view, 'preparation')
  f.session.editInput('instruction', 'Keep this draft')
  const count = f.calls.length
  assert.equal(f.session.switchView('dashboard'), true)
  assert.equal(f.session.switchView('topology'), false)
  f.session.switchView('preparation')
  assert.equal(f.state.input.instruction, 'Keep this draft')
  assert.equal(f.calls.length, count)
  assert.deepEqual(f.calls.map(c => c.name), ['environment.scan', 'examples.list'])
})
test('read-only environment discovery never blocks access to the dashboard', async () => {
  let finish
  const f = fixture({ 'environment.scan': () => new Promise(resolve => { finish = resolve }) })
  const scan = f.session.scan()
  assert.equal(f.state.busyKind, 'read'); assert.equal(f.session.switchView('dashboard'), true)
  finish(structuredClone(env)); await scan
  assert.equal(f.state.view, 'dashboard'); assert.equal(f.state.busy, false)
  assert.deepEqual(f.calls.map(c => c.name), ['environment.scan', 'examples.list'])
})
test('standalone preview cannot call a worker or enable mutations', async () => {
  const session = createPluginSession(null)
  session.selectWorkspace('work')
  assert.equal(session.canPrepare('install-tmux'), false)
  await session.scan()
  assert.match(session.state.error, /standalone preview is read-only/)
  assert.equal(session.switchView('dashboard'), true)
})
test('instruction review and confirmation use the same server plan and never send a command from the UI', async () => {
  const f = fixture({ 'setup.prepare': input => plan({ action: input.action, instruction: { key: seat.key, session: seat.session, runtime: seat.runtime, text: input.message } }), 'setup.execute': () => ({ terminalId: 'term-result', visibility: 'unverified', recoveryCommand: 'recover-existing' }) })
  await ready(f); await f.session.refreshSeats(); f.session.switchView('dashboard')
  f.session.editInput('instructionSeat', seat.key); f.session.editInput('instruction', 'Inspect the fixture')
  await f.session.prepare('send-instruction')
  assert.equal(f.calls.some(c => c.name === 'setup.execute'), false)
  assert.equal(f.state.plan.instruction.text, 'Inspect the fixture')
  await f.session.confirm()
  const execution = f.calls.find(c => c.name === 'setup.execute')
  assert.deepEqual(execution.input, { planId: 'plan-fixture', workspaceId: 'work' })
  assert.equal(f.state.receipt.terminalId, 'term-result'); assert.equal(f.state.input.instruction, '')
  await f.session.confirm(); assert.equal(f.calls.filter(c => c.name === 'setup.execute').length, 1)
})
test('editing a destination, content or view invalidates review and preserves unrelated drafts', async () => {
  const f = fixture({ 'setup.prepare': () => plan({ action: 'install-tmux' }) }); await ready(f)
  await f.session.prepare('install-tmux'); f.session.editInput('body', 'Task draft'); assert.equal(f.state.plan, null)
  await f.session.prepare('install-tmux'); f.session.switchView('dashboard'); assert.equal(f.state.plan, null)
  assert.equal(f.state.input.body, 'Task draft')
  await f.session.prepare('install-tmux'); f.session.selectWorkspace(''); assert.equal(f.state.plan, null)
})
test('single-seat start requires risk acknowledgment and handles an already-running no-op without a receipt', async () => {
  const stopped = { ...seat, session: '', status: 'not-started', activity: 'unknown' }
  const f = fixture({ 'seats.list': () => ({ seats: [stopped] }), 'setup.prepare': () => plan({ action: 'launch-seat', seatLaunch: stopped }), 'setup.execute': () => ({ noOp: true, detail: 'Reported running; left unchanged.' }) })
  await ready(f); await f.session.refreshSeats(); await f.session.prepare('launch-seat', { seatKey: seat.key })
  await f.session.confirm(); assert.equal(f.calls.some(c => c.name === 'setup.execute'), false)
  f.session.acknowledge(true); await f.session.confirm()
  assert.deepEqual(f.calls.find(c => c.name === 'setup.execute').input, { planId: 'plan-fixture', workspaceId: 'work', acceptStartupRisk: true })
  assert.equal(f.state.receipt, null); assert.match(f.state.notice, /left unchanged/)
})
test('an ambiguous task confirmation retains its fixed ID, clears the review and never retries', async () => {
  const id = 'qitem-orca-' + 'a'.repeat(32)
  const f = fixture({ 'seats.list': () => ({ seats: [{ ...seat, activity: 'working' }] }), 'setup.prepare': input => plan({ action: 'create-task', queueTask: { id, destination: seat.session, summary: input.summary, body: input.body } }), 'setup.execute': () => { throw new Error('Ambiguous timeout') }, 'task.check': () => ({ id, destination: seat.session, registration: 'verified', state: 'pending', detail: 'Matching row exists, not completion.' }) })
  await ready(f); await f.session.refreshSeats(); f.session.editInput('taskSeat', seat.key); f.session.editInput('summary', 'Inspect fixture'); f.session.editInput('body', 'Line one\nLine two')
  await f.session.prepare('create-task'); await f.session.confirm()
  assert.equal(f.state.task.id, id); assert.equal(f.state.task.registration, 'unverified'); assert.equal(f.state.plan, null)
  assert.match(f.state.error, /Ambiguous/)
  await f.session.confirm(); await f.session.checkTask()
  assert.equal(f.state.task.registration, 'verified'); assert.equal(f.calls.filter(c => c.name === 'setup.execute').length, 1)
})
test('accepted example receipts survive a failed example refresh and do not duplicate execution', async () => {
  let reads = 0
  const f = fixture({ 'examples.list': () => { if (++reads > 1) throw new Error('Refresh failed'); return { examples: [] } }, 'setup.prepare': () => plan({ action: 'example-demo', example: { id: '0123456789ab' } }), 'setup.execute': () => ({ terminalId: 'term-example' }) })
  await ready(f); await f.session.prepare('example-demo'); await f.session.confirm()
  assert.equal(f.state.receipt.terminalId, 'term-example'); assert.match(f.state.warning, /already created/)
  assert.equal(f.calls.filter(c => c.name === 'setup.execute').length, 1)
})
test('seat view defaults to read-only and recovery uses its existing terminal receipt', async () => {
  const f = fixture({ 'seat.attach': () => ({ terminalId: 'term-seat' }), 'terminal.reveal': input => ({ terminalId: input.terminalId, visibility: 'shown' }) })
  await ready(f); await f.session.refreshSeats(); await f.session.attach(seat.key); await f.session.reveal()
  assert.deepEqual(f.calls.find(c => c.name === 'seat.attach').input, { key: seat.key, workspaceId: 'work', readOnly: true })
  assert.deepEqual(f.calls.find(c => c.name === 'terminal.reveal').input, { terminalId: 'term-seat' })
  assert.equal(f.state.receipt.visibility, 'shown')
})
test('unsaved configuration and busy work block review, navigation and accidental rechecks', async () => {
  let finish
  const f = fixture({ 'setup.prepare': () => new Promise(resolve => { finish = resolve }) }); await ready(f)
  const preparing = f.session.prepare('install-tmux')
  assert.equal(f.state.busy, true); assert.equal(f.session.switchView('dashboard'), false)
  finish(plan({ action: 'install-tmux' })); await preparing
  f.session.editConfig('root', '/fixture/another-instance')
  assert.equal(f.state.plan, null); assert.equal(f.session.canPrepare('install-tmux'), false)
  const count = f.calls.length; await f.session.scan(); assert.equal(f.calls.length, count); assert.match(f.state.error, /Save configuration/)
})
