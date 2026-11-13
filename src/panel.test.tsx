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

test('host failures show a retryable screen instead of triggering installation', async () => {
  panel = await mount(panelModule, { host: mockHost({ requests: { 'environment.scan': () => { throw hostError('unavailable', 'Offline host') } } }) })
  assert.ok(panel.find({ text: 'Offline host' }))
  assert.ok(panel.find({ text: 'Retry environment check' }))
  assert.deepEqual(panel.errors, [])
})
