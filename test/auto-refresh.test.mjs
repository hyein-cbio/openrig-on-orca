import test from 'node:test'
import assert from 'node:assert/strict'
import { createPluginSession } from '../src/plugin-state.mjs'
import { podsFromSeats } from '../src/pods.mjs'
import { REFRESH_MS } from '../src/refresh-loop.mjs'
import { testClock } from './refresh-clock.mjs'
const seat = { key: '["rig","dev.worker"]', rigId: 'rig', rigName: 'demo', logicalId: 'dev.worker', podId: 'pod', podNamespace: 'dev', session: 'dev-worker@demo', runtime: 'pi', status: 'running', activity: 'idle', attention: false }
const podKey = JSON.stringify([seat.rigId, seat.podId]), instanceKey = 'a'.repeat(64)
async function fixture() {
  const clock = testClock(), calls = []; let seatValue = seat, mode = '', hold, heldSignal
  const env = { config: { provider: 'none', root: '/fixture/data', daemonPort: '43811' }, workspaces: [{ id: 'work', name: 'Fixture', path: '/fixture/project', hostId: 'local' }], snapshot: { installed: true, ready: true, tools: {} }, daemon: { status: 'reachable' } }
  const inventory = () => ({ connection: { source: 'tui', key: mode === 'instance' ? 'b'.repeat(64) : instanceKey, matchesConfigured: true }, observedAt: clock.now(), seats: [structuredClone(seatValue)], pods: mode === 'missing' ? [] : podsFromSeats([seatValue]) })
  const session = createPluginSession(async (name, input, options) => {
    calls.push({ name, input, options })
    if (name === 'environment.scan') return structuredClone(env)
    if (name === 'examples.list') return { examples: [] }
    if (name === 'pods.list') {
      if (mode === 'fail') throw Error('PRIVATE_FIXTURE')
      if (mode === 'hold') { heldSignal = options.signal; return new Promise(resolve => { hold = () => resolve(inventory()) }) }
      return inventory()
    }
    if (name === 'pods.edges') { if (mode === 'edges-fail') throw Error('PRIVATE_FIXTURE'); return { ...input, memberKeys: [seat.key], observedAt: clock.now(), status: 'complete', edges: [], notes: [] } }
    if (name === 'setup.prepare') return { id: 'plan', expires: clock.now() + 300000, workspaceId: 'work', action: input.action, instruction: { session: seat.session }, title: 'Review fixture' }
    throw Error(`Unexpected request: ${name}`)
  }, () => {}, { clock })
  await session.scan(); session.selectWorkspace('work'); session.selectPod(podKey); await session.refreshRelations(); session.switchView('dashboard'); session.setPanelVisibility(true)
  return { session, state: session.state, clock, calls, mode: value => { mode = value }, seat: value => { seatValue = value }, release: () => hold(), heldSignal: () => heldSignal }
}
test('one-minute auto refresh reads only observations, preserves identical objects and keeps form drafts', async () => {
  const f = await fixture(); f.session.editInput('instructionSeat', seat.key); f.session.editInput('instruction', 'Keep this draft')
  const inventory = f.state.inventory, relations = f.state.relations, start = f.calls.length
  assert.equal(f.state.autoRefresh.enabled, false); f.session.setAutoRefresh(true)
  await f.clock.advance(REFRESH_MS - 1); assert.equal(f.calls.length, start); await f.clock.advance(1)
  assert.deepEqual(f.calls.slice(start).map(c => c.name), ['pods.list', 'pods.edges'])
  assert.equal(f.state.inventory, inventory); assert.equal(f.state.relations, relations); assert.equal(f.state.input.instruction, 'Keep this draft'); assert.equal(f.state.input.instructionSeat, seat.key)
  assert.equal(f.state.observation.seatsAt, f.clock.now()); assert.equal(f.session.observationStatus().seatsStale, false); assert.equal(f.state.autoRefresh.failures, 0)
  f.session.dispose()
})
test('failed reads retain and label the last-good snapshot, back off, and never report a stopped/missing seat', async () => {
  const f = await fixture(), prior = f.state.inventory, pod = f.state.podKey
  f.mode('fail'); f.session.setAutoRefresh(true); await f.clock.advance(REFRESH_MS)
  assert.equal(f.state.inventory, prior); assert.equal(f.state.podKey, pod); assert.equal(f.state.inventory.seats[0].status, 'running')
  assert.equal(f.session.observationStatus().seatsStale, true); assert.ok(f.state.observation.seatsError); assert.equal(f.state.autoRefresh.nextAt - f.clock.now(), 2 * REFRESH_MS)
  assert.equal(JSON.stringify(f.state.observation).includes('PRIVATE_FIXTURE'), false); assert.equal(f.session.podConnected(), false)
  f.session.dispose()
})
test('relationship failures preserve previous connections independently of successful fresh seat observations', async () => {
  const f = await fixture(), previous = f.state.relations, at = f.state.observation.relationsAt
  f.mode('edges-fail'); f.seat({ ...seat, activity: 'working' }); f.session.setAutoRefresh(true); await f.clock.advance(REFRESH_MS)
  assert.equal(f.state.inventory.seats[0].activity, 'working'); assert.equal(f.state.relations, previous)
  assert.equal(f.state.observation.relationsAt, at); assert.ok(f.state.observation.relationsError); assert.equal(f.session.observationStatus().seatsStale, false); assert.equal(f.session.observationStatus().relationsStale, true)
  assert.equal(f.state.autoRefresh.failures, 1); f.session.dispose()
})
test('reviews and unsaved settings pause polling without clearing review or executing anything', async () => {
  const f = await fixture(); f.session.editInput('instructionSeat', seat.key); f.session.editInput('instruction', 'Inspect fixture'); await f.session.prepare('send-instruction')
  const plan = f.state.plan, start = f.calls.length
  f.session.setAutoRefresh(true); await f.clock.advance(2 * REFRESH_MS); assert.equal(f.calls.length, start); assert.equal(f.state.plan, plan)
  f.session.cancel(); await f.clock.advance(0); assert.equal(f.calls.length, start + 2)
  f.session.editConfig('daemonPort', '17459'); const count = f.calls.length; await f.clock.advance(5 * REFRESH_MS); assert.equal(f.calls.length, count)
  f.session.editConfig('daemonPort', '43811'); await f.clock.advance(0); assert.equal(f.calls.length, count + 2)
  assert.equal(f.calls.some(c => ['setup.execute', 'pods.connect', 'seat.report'].includes(c.name)), false); f.session.dispose()
})
test('hiding cancels an in-flight observation and discards late data, then resumes with one overdue read', async () => {
  const f = await fixture(), old = f.state.inventory
  f.mode('hold'); f.session.setAutoRefresh(true); await f.clock.advance(REFRESH_MS); assert.equal(f.state.autoRefresh.inFlight, true)
  f.session.setPanelVisibility(false); assert.equal(f.heldSignal().aborted, true); f.seat({ ...seat, activity: 'working' }); f.release(); await f.clock.flush()
  assert.equal(f.state.inventory, old); const count = f.calls.length; await f.clock.advance(5 * REFRESH_MS); assert.equal(f.calls.length, count)
  f.mode(''); f.session.setPanelVisibility(true); await f.clock.advance(0); assert.equal(f.calls.length, count + 2); assert.equal(f.state.inventory.seats[0].activity, 'working'); f.session.dispose()
})
test('instance changes and missing pods retain old data without silently selecting or reconnecting another target', async () => {
  for (const mode of ['instance', 'missing']) {
    const f = await fixture(), old = f.state.inventory
    f.mode(mode); f.session.setAutoRefresh(true); await f.clock.advance(REFRESH_MS)
    assert.equal(f.state.inventory, old); assert.equal(f.state.podKey, podKey); assert.equal(f.session.podConnected(), false); assert.equal(f.calls.some(c => c.name === 'pods.connect'), false)
    assert.ok(f.state.observation.seatsError); f.session.dispose()
  }
})
