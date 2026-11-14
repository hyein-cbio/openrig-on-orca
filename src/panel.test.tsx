import { afterEach, assert, hostError, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panelModule from './panel'
import { installed, installPlan, missing, ready } from './fixtures'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

test('fresh install renders without requiring providers or optional workspace apps', async () => {
  panel = await mount(panelModule, { host: mockHost({ requests: { 'environment.scan': missing } }) })
  assert.ok(panel.find({ text: 'OpenRig for Orca' }))
  assert.equal(panel.valueOf({ label: 'Coding agent' }), 'none')
  assert.ok(panel.find({ text: /Installation can finish without an agent/ }))
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
  assert.deepEqual(panel.refusals, [])
})

test('preparing and cancelling a plan never executes it; confirmation passes only its ID', async () => {
  let executions: unknown[] = []
  const host = mockHost({ requests: {
    'environment.scan': missing,
    'setup.prepare': installPlan,
    'setup.execute': input => { executions.push(input); return { terminalId: 'terminal-1' } }
  } })
  panel = await mount(panelModule, { host })
  await panel.select({ label: 'Destination Orca workspace' }, 'workspace')
  await panel.press({ text: 'Install managed OpenRig' })
  assert.equal(executions.length, 0)
  assert.ok(panel.find({ text: /Review · Install OpenRig/ }))
  await panel.press({ text: 'Cancel plan' })
  assert.equal(executions.length, 0)
  await panel.press({ text: 'Install managed OpenRig' })
  await panel.press({ text: 'Confirm and open in Orca terminal' })
  assert.deepEqual(executions, [{ planId: 'plan-1', workspaceId: 'workspace' }])
  assert.ok(panel.find({ text: /not proof that the command succeeded/ }))
  assert.deepEqual(panel.errors, [])
  assert.deepEqual(panel.warnings, [])
})

test('editing paths invalidates a pending plan and requires saving first', async () => {
  panel = await mount(panelModule, { host: mockHost({ requests: { 'environment.scan': missing, 'setup.prepare': installPlan } }) })
  await panel.select({ label: 'Destination Orca workspace' }, 'workspace')
  await panel.press({ text: 'Install managed OpenRig' })
  await panel.select({ label: 'OpenRig sections' }, 'paths')
  await panel.type({ label: 'Node executable' }, '/different/node', { replace: true })
  assert.equal(panel.find({ text: 'Confirm and open in Orca terminal' }), null)
  assert.ok(panel.summary().some(line => line.includes('Unsaved configuration')))
  assert.deepEqual(panel.refusals, [])
})

test('installed without agent permits daemon setup but leaves team launch disabled', async () => {
  panel = await mount(panelModule, { host: mockHost({ requests: { 'environment.scan': installed } }) })
  await panel.select({ label: 'Destination Orca workspace' }, 'workspace')
  const daemon = panel.find({ text: 'Start daemon · no agents' })
  assert.ok(daemon)
  await panel.select({ label: 'OpenRig sections' }, 'teams')
  await assert.rejects(panel.press({ text: 'Preview team launch' }))
  assert.deepEqual(panel.errors, [])
})

test('live seats are refreshed explicitly and seat views default to read-only', async () => {
  let attached: unknown
  const seat = { key: '["rig","builder"]', rigId: 'rig', rigName: 'Demo', logicalId: 'builder', session: 'builder@demo', runtime: 'codex', status: 'running', attention: true, activity: 'waiting' }
  panel = await mount(panelModule, { host: mockHost({ requests: {
    'environment.scan': ready, 'seats.list': { seats: [seat] },
    'seat.attach': input => { attached = input; return { terminalId: 'seat-terminal' } }
  } }) })
  await panel.select({ label: 'Destination Orca workspace' }, 'workspace')
  await panel.select({ label: 'OpenRig sections' }, 'teams')
  await panel.press({ text: 'Refresh seats' })
  assert.ok(panel.find({ text: 'Needs attention' }))
  await panel.press({ text: 'Open seat view' })
  assert.deepEqual(attached, { key: seat.key, workspaceId: 'workspace', readOnly: true })
  assert.ok(panel.find({ text: /Closing the view only detaches/ }))
  assert.deepEqual(panel.warnings, [])
  assert.deepEqual(panel.refusals, [])
})

test('launch review displays declarations and native uncertainties before terminal execution', async () => {
  let executed = false
  panel = await mount(panelModule, { host: mockHost({ requests: {
    'environment.scan': ready,
    'setup.prepare': { id: 'frozen', expires: 9999999999999, action: 'launch-team', title: 'Frozen launch', source: 'https://github.com/mvschwarz/openrig', writes: ['/private/review'], warnings: ['Accept unverified settings separately before LAUNCH.'], command: 'node frozen-launch.mjs', workspaceId: 'workspace', launchReview: { display: { seats: [{ runtime: 'codex', model: 'UNVERIFIED' }], unverified: ['Native settings unavailable'] } } },
    'setup.execute': () => { executed = true; return { terminalId: 't' } }
  } }) })
  await panel.select({ label: 'Destination Orca workspace' }, 'workspace')
  await panel.select({ label: 'OpenRig sections' }, 'teams')
  await panel.type({ label: 'Absolute local YAML spec' }, '/project/rig.yaml')
  await panel.press({ text: 'Preview team launch' })
  assert.ok(panel.find({ label: 'Frozen launch declarations and unverified settings' }))
  assert.match(JSON.stringify(panel.tree()), /UNVERIFIED/)
  assert.equal(executed, false)
  assert.deepEqual(panel.warnings, [])
})

test('review replaces the long setup form until cancelled or another tab is selected', async () => {
  panel = await mount(panelModule, { host: mockHost({ requests: { 'environment.scan': missing, 'setup.prepare': installPlan } }) })
  assert.ok(panel.summary().some(line => line.includes('Choose a destination first')))
  await panel.select({ label: 'Destination Orca workspace' }, 'workspace')
  await panel.press({ text: 'Install managed OpenRig' })
  assert.ok(panel.find({ text: /Review · Install OpenRig/ }))
  assert.equal(panel.find({ text: 'Install managed OpenRig' }), null)
  assert.ok(panel.find({ text: /Destination: project \/ Plugin sandbox/ }))
  await panel.select({ label: 'OpenRig sections' }, 'paths')
  assert.equal(panel.find({ text: 'Confirm and open in Orca terminal' }), null)
  assert.ok(panel.find({ label: 'Node executable' }))
})

test('dashboard is blocked until daemon responds and enabled after explicit recheck', async () => {
  let scans = 0, prepared = 0
  panel = await mount(panelModule, { host: mockHost({ requests: {
    'environment.scan': () => ++scans === 1 ? installed : { ...installed, daemon: { status: 'reachable', detail: 'Responded without starting agents.' } },
    'setup.prepare': () => { prepared++; return { ...installPlan, action: 'console' } }
  } }) })
  await panel.select({ label: 'Destination Orca workspace' }, 'workspace')
  await assert.rejects(panel.press({ text: 'Open dashboard' }))
  assert.equal(prepared, 0)
  assert.ok(panel.find({ text: /Dashboard is disabled until this instance responds/ }))
  await panel.press({ text: 'Recheck environment' })
  await panel.press({ text: 'Open dashboard' })
  assert.equal(prepared, 1)
})

test('hidden terminal recovery reveals only the accepted terminal, never re-executes the plan', async () => {
  let executions = 0, reveals: unknown[] = []
  panel = await mount(panelModule, { host: mockHost({ requests: {
    'environment.scan': missing, 'setup.prepare': installPlan,
    'setup.execute': () => { executions++; return { terminalId: 'term-owned', visibility: 'unverified', recoveryCommand: 'orca terminal switch --terminal term-owned --json' } },
    'terminal.reveal': input => { reveals.push(input); return { terminalId: 'term-owned', visibility: 'shown' } }
  } }) })
  await panel.select({ label: 'Destination Orca workspace' }, 'workspace')
  await panel.press({ text: 'Install managed OpenRig' })
  await panel.press({ text: 'Confirm and open in Orca terminal' })
  assert.ok(panel.summary().some(line => line.includes('Terminal created · tab not verified')))
  assert.ok(panel.find({ label: 'Manual terminal recovery · does not rerun the action' }))
  await panel.press({ text: 'Show / recover existing terminal' })
  assert.deepEqual(reveals, [{ terminalId: 'term-owned' }])
  assert.equal(executions, 1)
  assert.ok(panel.summary().some(line => line.includes('Terminal tab connected')))
  assert.deepEqual(panel.errors, []); assert.deepEqual(panel.warnings, []); assert.deepEqual(panel.refusals, [])
})

test('failed recovery keeps the original receipt available instead of offering re-execution', async () => {
  panel = await mount(panelModule, { host: mockHost({ requests: {
    'environment.scan': missing, 'setup.prepare': installPlan,
    'setup.execute': { terminalId: 'term-owned', visibility: 'unverified' },
    'terminal.reveal': () => { throw new Error('No saved receipt') }
  } }) })
  await panel.select({ label: 'Destination Orca workspace' }, 'workspace')
  await panel.press({ text: 'Install managed OpenRig' })
  await panel.press({ text: 'Confirm and open in Orca terminal' })
  await panel.press({ text: 'Show / recover existing terminal' })
  assert.ok(panel.find({ text: /Created terminal term-owned/ }))
  assert.ok(panel.find({ text: 'No saved receipt' }))
  assert.equal(panel.find({ text: 'Confirm and open in Orca terminal' }), null)
})

test('one idle Pi agent can receive a reviewed instruction without enabling agent installation', async () => {
  const seat = { key: '["rig-1","dev.worker"]', rigId: 'rig-1', rigName: 'demo', logicalId: 'dev.worker', session: 'dev-worker@demo', runtime: 'pi', status: 'running', attention: false, activity: 'idle' }
  const prepared: unknown[] = [], executed: unknown[] = []
  panel = await mount(panelModule, { host: mockHost({ requests: {
    'environment.scan': installed, 'seats.list': { seats: [seat] },
    'setup.prepare': input => {
      prepared.push(input)
      return { ...installPlan, action: 'send-instruction', title: 'Send instruction', instruction: { key: seat.key, session: seat.session, runtime: seat.runtime, text: input.message! } }
    },
    'setup.execute': input => { executed.push(input); return { terminalId: 'instruction-result' } }
  } }) })
  await panel.select({ label: 'Destination Orca workspace' }, 'workspace')
  await panel.select({ label: 'OpenRig sections' }, 'teams')
  await assert.rejects(panel.press({ text: 'Review instruction' }))
  await panel.press({ text: 'Refresh seats' })
  await panel.select({ label: 'Instruction recipient' }, seat.key)
  await panel.type({ label: 'Short instruction' }, 'Inspect the latest diff.')
  await panel.press({ text: 'Review instruction' })
  assert.deepEqual(prepared, [{ action: 'send-instruction', workspaceId: 'workspace', spec: '', seatKey: seat.key, message: 'Inspect the latest diff.' }])
  assert.ok(panel.find({ label: 'Reviewed instruction' }))
  assert.equal(executed.length, 0)
  await panel.press({ text: 'Cancel plan' })
  assert.equal(executed.length, 0)
  await panel.type({ label: 'Short instruction' }, 'Explain the diff without edits.', { replace: true })
  await panel.press({ text: 'Review instruction' })
  await panel.press({ text: 'Confirm and open in Orca terminal' })
  assert.deepEqual(executed, [{ planId: installPlan.id, workspaceId: 'workspace' }])
  assert.equal(panel.valueOf({ label: 'Short instruction' }), '')
  assert.deepEqual(panel.errors, []); assert.deepEqual(panel.warnings, []); assert.deepEqual(panel.refusals, [])
})

test('shell, busy and attention-requesting seats cannot be selected for instructions', async () => {
  const base = { rigId: 'rig-1', rigName: 'demo', logicalId: 'worker', session: 'worker@demo', runtime: 'pi', status: 'running', attention: false, activity: 'idle' }
  panel = await mount(panelModule, { host: mockHost({ requests: {
    'environment.scan': installed,
    'seats.list': { seats: [{ ...base, key: 'shell', runtime: 'terminal' }, { ...base, key: 'busy', activity: 'working' }, { ...base, key: 'attention', attention: true }] }
  } }) })
  await panel.select({ label: 'Destination Orca workspace' }, 'workspace')
  await panel.select({ label: 'OpenRig sections' }, 'teams')
  await panel.press({ text: 'Refresh seats' })
  for (const key of ['shell', 'busy', 'attention']) await assert.rejects(panel.select({ label: 'Instruction recipient' }, key))
  await panel.type({ label: 'Short instruction' }, 'Please inspect the diff.')
  await assert.rejects(panel.press({ text: 'Review instruction' }))
  assert.deepEqual(panel.errors, []); assert.deepEqual(panel.warnings, [])
})

test('a never-started seat has a single-start review with mandatory startup acknowledgment', async () => {
  const seat = { key: '["rig-1","dev.worker"]', rigId: 'rig-1', rigName: 'demo', logicalId: 'dev.worker', session: '', runtime: 'pi', status: 'not-started', lifecycle: 'detached', activity: 'unknown', attention: false }
  let accepted: unknown
  panel = await mount(panelModule, { host: mockHost({ requests: {
    'environment.scan': installed, 'seats.list': { seats: [seat] },
    'setup.prepare': { ...installPlan, action: 'launch-seat', title: 'Start one seat', seatLaunch: seat },
    'setup.execute': input => { accepted = input; return { noOp: true, detail: 'The seat is already running and was left unchanged.' } }
  } }) })
  await panel.select({ label: 'Destination Orca workspace' }, 'workspace')
  await panel.select({ label: 'OpenRig sections' }, 'teams')
  await panel.press({ text: 'Refresh seats' })
  assert.ok(panel.find({ text: 'No session yet' }))
  await panel.press({ testId: `start:${seat.key}` })
  await assert.rejects(panel.press({ text: 'Confirm and open in Orca terminal' }))
  assert.equal(accepted, undefined)
  await panel.toggle({ label: 'I accept unverified native startup settings and possible model costs' })
  await panel.press({ text: 'Confirm and open in Orca terminal' })
  assert.deepEqual(accepted, { planId: installPlan.id, workspaceId: 'workspace', acceptStartupRisk: true })
  assert.ok(panel.find({ text: /already running and was left unchanged/ }))
  assert.deepEqual(panel.errors, []); assert.deepEqual(panel.warnings, [])
})

test('durable task GUI preserves the request ID and reads registration without resubmitting', async () => {
  const seat = { key: '["rig-1","dev.worker"]', rigId: 'rig-1', rigName: 'demo', logicalId: 'dev.worker', session: 'dev-worker@demo', runtime: 'pi', status: 'running', activity: 'working', attention: false }
  const id = 'qitem-orca-' + 'a'.repeat(32)
  let creates = 0, checks: unknown[] = []
  panel = await mount(panelModule, { host: mockHost({ requests: {
    'environment.scan': installed, 'seats.list': { seats: [seat] },
    'setup.prepare': input => ({ ...installPlan, action: 'create-task', title: 'Register task', queueTask: { id, destination: seat.session, key: seat.key, runtime: seat.runtime, summary: input.summary!, body: input.body!, bodyFile: '/sandbox/actions/body.txt' } }),
    'setup.execute': () => { creates++; return { terminalId: 'task-result' } },
    'task.check': input => { checks.push(input); return { id, destination: seat.session, registration: 'verified', state: 'done', detail: 'Matching durable row exists; not proof of correct results.' } }
  } }) })
  await panel.select({ label: 'Destination Orca workspace' }, 'workspace')
  await panel.select({ label: 'OpenRig sections' }, 'teams')
  await panel.press({ text: 'Refresh seats' })
  await panel.select({ label: 'Task recipient' }, seat.key)
  await panel.type({ label: 'Task title' }, 'Inspect the fixture')
  await panel.type({ label: 'Task body' }, 'First line\nSecond line')
  await panel.press({ text: 'Review durable task' })
  assert.ok(panel.find({ label: 'Reviewed task body' }))
  assert.equal(creates, 0)
  await panel.press({ text: 'Confirm and open in Orca terminal' })
  assert.equal(creates, 1)
  assert.ok(panel.find({ text: id }))
  assert.ok(panel.find({ text: /Registration: unverified/ }))
  await panel.press({ text: 'Check task registration' })
  assert.deepEqual(checks, [{ id }]); assert.equal(creates, 1)
  assert.ok(panel.find({ text: /Registration: verified/ }))
  assert.ok(panel.find({ text: /Recorded done is not proof/ }))
  assert.equal(panel.valueOf({ label: 'Task body' }), '')
  assert.deepEqual(panel.errors, []); assert.deepEqual(panel.warnings, []); assert.deepEqual(panel.refusals, [])
})

test('host failures show a retryable screen instead of triggering installation', async () => {
  panel = await mount(panelModule, { host: mockHost({ requests: { 'environment.scan': () => { throw hostError('unavailable', 'Offline host') } } }) })
  assert.ok(panel.find({ text: 'Offline host' }))
  assert.ok(panel.find({ text: 'Retry environment check' }))
  assert.deepEqual(panel.errors, [])
})
