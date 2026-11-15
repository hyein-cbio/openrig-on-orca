import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as workerModule from './worker'

test('additional Intel worker activation retains the original no-side-effects contract', async () => {
  const host = mockHost({ results: { 'workspace.list': { workspaces: [], truncated: false } } })
  const worker = await mountWorker(workerModule, { host })
  try {
    assert.equal(host.calls.length, 0)
    await assert.rejects(worker.request('setup.execute', { planId: 'unprepared', workspaceId: 'none' }), /Choose an existing local Orca workspace/)
    assert.equal(host.callsOf('terminal.create').length, 0)
  } finally { await worker.deactivate() }
})

test('additional Intel worker reuses the original configuration flow without persisting its path defaults', async () => {
  const host = mockHost({ results: { 'workspace.list': { workspaces: [], truncated: false } } })
  const worker = await mountWorker(workerModule, { host })
  try {
    const state = await worker.request('environment.scan')
    const expected = process.platform === 'darwin' && process.arch === 'x64' ? '/opt/local/bin' : ''
    assert.equal(state.config.extraPath, expected)
    assert.equal(host.callsOf('storage.set').length, 0)
    assert.equal(host.callsOf('terminal.create').length, 0)
    await assert.rejects(worker.request('config.save', { provider: 'invalid' } as never), /Choose none/)
    assert.equal(host.callsOf('storage.set').length, 0)
  } finally { await worker.deactivate() }
})
