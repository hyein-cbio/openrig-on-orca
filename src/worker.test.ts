import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as workerModule from './worker'

const workspace = { id: 'local-test', name: 'Sandbox', path: '/sandbox/project', hostId: 'local', kind: 'folder', branch: null }

test('worker activation performs no scan, install, authentication or launch', async () => {
  const host = mockHost()
  const worker = await mountWorker(workerModule, { host })
  assert.equal(host.calls.length, 0)
  assert.deepEqual(worker.logs, [])
  await worker.deactivate()
})

test('an unprepared panel command cannot execute arbitrary shell text', async () => {
  const host = mockHost({ results: { 'workspace.list': { workspaces: [workspace], truncated: false } } })
  const worker = await mountWorker(workerModule, { host })
  await assert.rejects(worker.request('setup.execute', { planId: 'made-up', workspaceId: workspace.id }), /Prepare a new plan/)
  assert.equal(host.callsOf('terminal.create').length, 0)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('unknown config does not write state or perform setup', async () => {
  const host = mockHost()
  const worker = await mountWorker(workerModule, { host })
  // Deliberately malformed runtime input, as a stale or faulty panel could send.
  await assert.rejects(worker.request('config.save', { provider: 'invalid' } as never), /Choose none/)
  assert.equal(host.callsOf('storage.set').length, 0)
  assert.equal(host.callsOf('terminal.create').length, 0)
  await worker.deactivate()
})

test('remote workspace is rejected before discovering or executing local tools', async () => {
  const host = mockHost({ results: { 'workspace.list': { workspaces: [{ ...workspace, hostId: 'remote-host' }], truncated: false } } })
  const worker = await mountWorker(workerModule, { host })
  await assert.rejects(worker.request('setup.prepare', { action: 'install-rig', workspaceId: workspace.id }), /local Orca workspace/)
  assert.equal(host.callsOf('terminal.create').length, 0)
  await worker.deactivate()
})
