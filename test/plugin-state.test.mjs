import test from 'node:test'
import assert from 'node:assert/strict'
import { createPluginSession } from '../src/plugin-state.mjs'
import { podsFromSeats, operationInstance } from '../src/pods.mjs'

const env = { config: { provider: 'none', root: '/fixture/data', daemonPort: '43811' },
  workspaces: [{ id: 'work', name: 'Fixture', path: '/fixture/project', hostId: 'local' }],
  snapshot: { installed: true, ready: true, stage: 'ready', tools: { node: '/fixture/node', npm: '/fixture/npm', rig: '/fixture/rig', tmux: '/fixture/tmux', claude: '/fixture/claude', codex: '/fixture/codex' }, providers: [], sqlite: { status: 'verified', detail: 'Fixture' } },
  daemon: { status: 'reachable', detail: 'Fixture endpoint' } }
const seat = { key: '["rig-1","dev.worker"]', rigId: 'rig-1', rigName: 'demo', logicalId: 'dev.worker', podId: 'pod-1', podNamespace: 'dev', session: 'dev-worker@demo', runtime: 'pi', status: 'running', activity: 'idle', attention: false }
function fixture(overrides = {}) {
  const calls = []
  const handlers = { 'environment.scan': () => structuredClone(env), 'examples.list': () => ({ examples: [] }), 'seats.list': () => ({ seats: [structuredClone(seat)] }), ...overrides }
  handlers['pods.list'] ||= async () => { const seats = (await handlers['seats.list']()).seats; return { connection: { source: 'tui', key: 'a'.repeat(64), home: '/fixture/native', port: '7433', endpoint: 'http://127.0.0.1:7433', matchesConfigured: true }, observedAt: Date.now(), pods: podsFromSeats(seats), seats } }
  const session = createPluginSession(async (name, input, options) => { calls.push({ name, input, options }); if (!handlers[name]) throw new Error(`Unexpected request: ${name}`); return handlers[name](input) })
  return { session, state: session.state, calls }
}
const plan = extra => ({ id: 'plan-fixture', workspaceId: 'work', expires: Date.now() + 60000, title: 'Fixture', command: 'never executed here', source: 'https://example.invalid', writes: [], warnings: [], ...extra })
async function ready(f) { await f.session.scan(); f.session.selectWorkspace('work'); f.session.selectPod(JSON.stringify([seat.rigId, seat.podId])) }

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
  assert.deepEqual(f.calls.map(c => c.name), ['environment.scan', 'examples.list', 'pods.list'])
})
test('read-only environment discovery never blocks access to the dashboard', async () => {
  let finish
  const f = fixture({ 'environment.scan': () => new Promise(resolve => { finish = resolve }) })
  const scan = f.session.scan()
  assert.equal(f.state.busyKind, 'read'); assert.equal(f.session.switchView('dashboard'), true)
  finish(structuredClone(env)); await scan
  assert.equal(f.state.view, 'dashboard'); assert.equal(f.state.busy, false)
  assert.deepEqual(f.calls.map(c => c.name), ['environment.scan', 'examples.list', 'pods.list'])
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
  await ready(f); await f.session.refreshSeats(); f.session.switchView('dashboard'); await f.session.attach(seat.key); await f.session.reveal()
  assert.deepEqual(f.calls.find(c => c.name === 'seat.attach').input, { key: seat.key, workspaceId: 'work', readOnly: true, podKey: JSON.stringify([seat.rigId, seat.podId]), instanceKey: 'a'.repeat(64) })
  assert.deepEqual(f.calls.find(c => c.name === 'terminal.reveal').input, { terminalId: 'term-seat' })
  assert.equal(f.state.receipt.visibility, 'shown')
})
test('pod selection is independent of terminal destination and filters identical namespaces by rig', async () => {
  const other = { ...seat, rigId: 'rig-2', rigName: 'other', key: '["rig-2","dev.worker"]' }
  const f = fixture({ 'seats.list': () => ({ seats: [seat, other] }), 'setup.prepare': input => plan({ action: input.action, instruction: { session: seat.session } }) })
  await f.session.scan(); assert.equal(f.state.podKey, '')
  f.session.selectPod(JSON.stringify([seat.rigId, seat.podId])); assert.equal(f.session.podSeats().length, 1)
  assert.equal(f.state.workspaceId, ''); f.session.selectWorkspace('work'); assert.equal(f.session.selectedPod().rigId, 'rig-1')
  f.session.editInput('instructionSeat', seat.key); f.session.editInput('instruction', 'Inspect fixture'); await f.session.prepare('send-instruction')
  assert.equal(f.calls.find(c => c.name === 'setup.prepare').input.podKey, JSON.stringify([seat.rigId, seat.podId]))
  f.session.selectPod(JSON.stringify([other.rigId, other.podId])); assert.equal(f.state.plan, null); assert.equal(f.state.input.instructionSeat, '')
  assert.equal(f.state.input.instruction, 'Inspect fixture'); assert.equal(f.session.podSeats()[0].rigId, 'rig-2')
  assert.equal(f.session.canPrepare('launch-seat', { seatKey: seat.key }), false)
})
test('observing another instance cannot silently enable operations or persist a connection', async () => {
  let connected = false
  const connection = { source: 'tui', key: 'a'.repeat(64), home: '/fixture/native', port: '7433', endpoint: 'http://127.0.0.1:7433' }
  const f = fixture({ 'pods.list': () => ({ connection: { ...connection, matchesConfigured: connected }, observedAt: Date.now(), pods: podsFromSeats([seat]), seats: [seat] }), 'pods.connect': input => { assert.equal(input.expectedKey, connection.key); connected = true; return { ...structuredClone(env), config: { ...env.config, instanceHome: connection.home, daemonPort: connection.port } } } })
  await ready(f); f.session.editInput('instructionSeat', seat.key); f.session.editInput('instruction', 'Inspect fixture')
  assert.equal(f.session.canPrepare('send-instruction'), false); assert.equal(f.calls.some(c => c.name === 'pods.connect'), false)
  await f.session.connectInventory(); assert.equal(f.state.env.config.instanceHome, '/fixture/native'); assert.equal(f.session.selectedPod().key, JSON.stringify([seat.rigId, seat.podId]))
  f.session.editInput('instructionSeat', seat.key); assert.equal(f.session.canPrepare('send-instruction'), true)
  assert.equal(f.session.canPrepare('start-daemon'), false)
  assert.equal(f.calls.some(c => c.name === 'setup.execute'), false)
})
test('report previews are lazy, bounded, cached per snapshot and independent of terminal destination', async () => {
  const f = fixture({ 'seat.report': input => ({ ...input, observedAt: 123, status: 'recorded', preview: 'REPORT_PREVIEW_FIXTURE', totalBytes: 1000, truncated: true, recipient: 'demo / dev.peer', recordedAt: '2026-01-01T12:00:00Z', delivery: 'indeterminate', detail: 'Native raw excerpt' }) })
  await ready(f); f.session.selectWorkspace('')
  assert.equal(f.calls.some(c => c.name === 'seat.report'), false)
  const first = await f.session.readReport(seat.key), second = await f.session.readReport(seat.key)
  assert.equal(first.status, 'recorded'); assert.equal(second.preview, 'REPORT_PREVIEW_FIXTURE')
  assert.equal(f.calls.filter(c => c.name === 'seat.report').length, 1)
  assert.equal(JSON.stringify(f.state).includes('REPORT_PREVIEW_FIXTURE'), false)
  f.session.setDiagramSource('yaml'); assert.equal((await f.session.readReport(seat.key)).status, 'unverified')
  assert.equal(f.calls.filter(c => c.name === 'seat.report').length, 1)
  f.session.setDiagramSource('inventory'); f.session.selectPod(f.state.podKey); await f.session.readReport(seat.key)
  assert.equal(f.calls.filter(c => c.name === 'seat.report').length, 2)
  assert.equal(f.calls.some(c => c.name === 'setup.execute'), false)
})
test('report preview failure and stale scope never expose a body from a different pod', async () => {
  let release
  const f = fixture({ 'seat.report': input => new Promise(resolve => { release = () => resolve({ ...input, observedAt: 123, status: 'recorded', preview: 'STALE_BODY_FIXTURE', totalBytes: 18, detail: 'Raw' }) }) })
  await ready(f); const pending = f.session.readReport(seat.key); f.session.selectPod(''); release()
  assert.equal((await pending).status, 'unverified')
  const failed = fixture({ 'seat.report': () => { throw Error('PRIVATE_FIXTURE') } }); await ready(failed)
  const result = await failed.session.readReport(seat.key); assert.equal(result.status, 'unverified'); assert.equal(JSON.stringify(result).includes('PRIVATE_FIXTURE'), false)
})
test('selected-pod relationship reads hydrate safely and never execute an operation', async () => {
  const podKey = JSON.stringify([seat.rigId, seat.podId])
  const f = fixture({ 'pods.edges': input => ({ ...input, memberKeys: [seat.key], observedAt: 123, status: 'complete', edges: [], notes: ['No same-pod relationships reported.'] }) })
  await ready(f); await f.session.refreshRelations()
  assert.equal(f.state.relations.status, 'complete'); assert.equal(f.state.relations.podKey, podKey)
  assert.deepEqual(f.calls.find(c => c.name === 'pods.edges').input, { source: 'tui', instanceKey: 'a'.repeat(64), podKey })
  assert.equal(f.calls.some(c => c.name === 'setup.execute'), false)
  f.session.selectPod(''); assert.equal(f.state.relations, null)
})
test('relationship failures stay unavailable and changed membership cannot claim a complete graph', async () => {
  const f = fixture({ 'pods.edges': () => { throw Error('PRIVATE_FIXTURE') } }); await ready(f); await f.session.refreshRelations()
  assert.equal(f.state.relations.status, 'unavailable'); assert.deepEqual(f.state.relations.edges, [])
  assert.equal(JSON.stringify(f.state.relations).includes('PRIVATE_FIXTURE'), false)
  const changed = fixture({ 'pods.edges': input => ({ ...input, memberKeys: [seat.key, 'new-member'], observedAt: 123, status: 'complete', edges: [], notes: [] }) }); await ready(changed); await changed.session.refreshRelations()
  assert.equal(changed.state.relations.status, 'partial'); assert.ok(changed.state.relations.notes.some(n => n.includes('Membership changed')))
})
test('recorded demo stop is scoped to the operation instance, not only the private data root', async () => {
  const record = { id: 'demo', kind: 'demo', instance: operationInstance(env.config) }
  const f = fixture({ 'examples.list': () => ({ examples: [record] }) }); await ready(f)
  assert.equal(f.session.canPrepare('stop-example', { exampleId: record.id }), true)
  f.state.env.config = { ...f.state.env.config, daemonPort: '17459' }; f.state.draft = { ...f.state.env.config }
  assert.equal(f.session.canPrepare('stop-example', { exampleId: record.id }), false)
  f.state.examples = [{ ...record, instance: undefined }]; assert.equal(f.session.canPrepare('stop-example', { exampleId: record.id }), false)
})
test('optional YAML preview invalidates review and locks pod actions without changing native selection', async () => {
  const f = fixture({ 'setup.prepare': () => plan({ action: 'send-instruction' }) }); await ready(f)
  f.session.editInput('instructionSeat', seat.key); f.session.editInput('instruction', 'Inspect fixture'); await f.session.prepare('send-instruction')
  assert.ok(f.state.plan); const podKey = f.state.podKey, calls = f.calls.length
  f.session.setDiagramSource('yaml'); assert.equal(f.state.plan, null); assert.equal(f.session.canPrepare('send-instruction'), false); assert.equal(f.state.podKey, podKey)
  f.session.setDiagramSource('inventory'); assert.equal(f.session.canPrepare('send-instruction'), true); assert.equal(f.calls.length, calls)
})
test('an unavailable pod inventory stays unknown and clears a prior selection without example fallback', async () => {
  let failing = false
  const f = fixture({ 'pods.list': () => { if (failing) throw new Error('Native observation unavailable'); return { connection: { matchesConfigured: true, key: 'a'.repeat(64) }, pods: podsFromSeats([seat]), seats: [seat] } } })
  await ready(f); assert.ok(f.session.selectedPod()); failing = true; await f.session.refreshPods()
  assert.equal(f.state.inventory, null); assert.equal(f.state.podKey, ''); assert.match(f.state.podError, /unavailable/)
  assert.equal(f.session.selectPod('made-up'), false); assert.deepEqual(f.session.podSeats(), [])
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
