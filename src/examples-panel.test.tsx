import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as module from './examples-panel'
import { installed, missing } from './fixtures'

let panel: TestPanel | undefined
afterEach(() => panel?.unmount())

test('walkthrough explains two roles without executing or preparing any command', async () => {
  let prepared = 0
  panel = await mount(module, { host: mockHost({ requests: { 'environment.scan': missing, 'examples.list': { examples: [] }, 'setup.prepare': () => { prepared++; throw new Error('must not prepare') } } }) })
  assert.ok(panel.find({ text: 'Example Window' }))
  await panel.press({ text: 'Next step' })
  assert.ok(panel.find({ text: 'Build' }))
  await panel.press({ text: 'Next step' })
  assert.ok(panel.find({ text: 'Review' }))
  await panel.press({ text: 'Restart walkthrough' })
  assert.equal(prepared, 0)
  assert.deepEqual(panel.errors, []); assert.deepEqual(panel.warnings, []); assert.deepEqual(panel.refusals, [])
})
test('destination options distinguish main worktrees by project without changing the action target', async () => {
  let prepared: unknown
  const state = { ...installed, workspaces: [
    { id: 'alpha', project: 'Alpha', name: 'main', path: '/alpha', hostId: 'local' },
    { id: 'beta', project: 'Beta', name: 'main', path: '/beta', hostId: 'local' },
    { id: 'remote', project: 'Remote', name: 'main', path: '/remote', hostId: 'ssh:other' }
  ] }
  panel = await mount(module, { host: mockHost({ requests: {
    'environment.scan': state, 'examples.list': { examples: [] },
    'setup.prepare': input => {
      prepared = input
      return { id: 'p', expires: 9999999999999, action: 'example-demo', title: 'Demo', source: 'https://github.com/mvschwarz/openrig', writes: [], warnings: [], command: 'safe', workspaceId: input.workspaceId }
    }
  } }) })
  const tree = JSON.stringify(panel.tree())
  assert.match(tree, /Alpha \/ main/)
  assert.match(tree, /Beta \/ main/)
  assert.equal(tree.includes('Remote / main'), false)
  await panel.select({ label: 'Example destination workspace' }, 'beta')
  assert.equal(panel.valueOf({ label: 'Example destination workspace' }), 'beta')
  await panel.press({ text: 'Prepare terminal demo' })
  assert.deepEqual(prepared, { action: 'example-demo', workspaceId: 'beta' })
  assert.ok(panel.find({ text: /Destination: Beta \/ main/ }))
  assert.deepEqual(panel.errors, []); assert.deepEqual(panel.warnings, []); assert.deepEqual(panel.refusals, [])
})

test('demo has a separate confirmation and sends only an immutable plan ID', async () => {
  let executed: unknown
  const example = { id: 'abcdef123456', kind: 'demo' as const, rigName: 'orca-example-demo-abcdef123456', directory: '/example', specPath: '/example/rig.yaml', configRoot: '/sandbox/openrig' }
  const plan = { id: 'demo-plan', expires: 9999999999999, action: 'example-demo', title: 'Terminal-only demo', source: 'https://github.com/mvschwarz/openrig', writes: ['/example'], warnings: ['SIMULATION ONLY'], command: 'reviewed-command', workspaceId: 'workspace', example }
  panel = await mount(module, { host: mockHost({ requests: { 'environment.scan': installed, 'examples.list': { examples: [] }, 'setup.prepare': plan, 'setup.execute': input => { executed = input; return { terminalId: 'demo-terminal' } } } }) })
  await panel.select({ label: 'Example destination workspace' }, 'workspace')
  await panel.press({ text: 'Prepare terminal demo' })
  assert.equal(executed, undefined)
  await panel.press({ text: 'Cancel example action' })
  assert.equal(executed, undefined)
  await panel.press({ text: 'Prepare terminal demo' })
  await panel.press({ text: 'Confirm example action' })
  assert.deepEqual(executed, { planId: 'demo-plan', workspaceId: 'workspace' })
  assert.deepEqual(panel.warnings, [])
})
test('accepted terminal receipt remains visible when the example list refresh fails', async () => {
  let lists = 0, executions = 0
  panel = await mount(module, { host: mockHost({ requests: {
    'environment.scan': installed,
    'examples.list': () => { if (++lists > 1) throw new Error('refresh unavailable'); return { examples: [] } },
    'setup.prepare': { id: 'receipt-plan', expires: 9999999999999, action: 'example-demo', title: 'Demo', source: 'https://github.com/mvschwarz/openrig', writes: [], warnings: [], command: 'safe', workspaceId: 'workspace' },
    'setup.execute': () => { executions++; return { terminalId: 'accepted-terminal' } }
  } }) })
  await panel.select({ label: 'Example destination workspace' }, 'workspace')
  await panel.press({ text: 'Prepare terminal demo' })
  await panel.press({ text: 'Confirm example action' })
  assert.equal(executions, 1)
  assert.ok(panel.find({ text: /Created terminal accepted-terminal/ }))
  assert.ok(panel.find({ text: /terminal was already created/ }))
  assert.equal(panel.find({ text: 'Confirm example action' }), null)
})

test('changing destination invalidates an example plan', async () => {
  panel = await mount(module, { host: mockHost({ requests: { 'environment.scan': installed, 'examples.list': { examples: [] }, 'setup.prepare': { id: 'p', expires: 9999999999999, action: 'example-demo', title: 'Demo', source: 'https://github.com/mvschwarz/openrig', writes: [], warnings: [], command: 'safe', workspaceId: 'workspace' } } }) })
  await panel.select({ label: 'Example destination workspace' }, 'workspace')
  await panel.press({ text: 'Prepare terminal demo' })
  await panel.select({ label: 'Example destination workspace' }, 'workspace')
  assert.equal(panel.find({ text: 'Confirm example action' }), null)
})
