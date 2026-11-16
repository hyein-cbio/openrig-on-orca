import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as workerModule from './worker'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { configFrom, quote } from './runtime.mjs'

const workspace = { id: 'local-test', project: 'Sandbox project', name: 'Sandbox', path: '/sandbox/project', hostId: 'local', kind: 'folder', branch: null }

async function daemonFixture(nodes: unknown[] = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'openrig-worker-daemon-'))
  const node = path.join(root, 'node')
  const rig = path.join(root, 'rig')
  const tmux = path.join(root, 'tmux')
  await writeFile(node, '#!/bin/sh\nif [ "$1" = "-p" ]; then printf \'%s\' \'{"version":"v22.23.1","electron":false}\'; fi\n', { mode: 0o700 })
  await writeFile(tmux, '#!/bin/sh\nprintf "tmux fixture"\n', { mode: 0o700 })
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@openrig/cli' }))
  const nodeFile = path.join(root, 'nodes.json')
  await writeFile(nodeFile, JSON.stringify(nodes))
  await writeFile(rig, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '0.7.13'; exit 0; fi\nif [ "$1" = "ps" ] && [ -f ${quote(path.join(root, 'online'))} ]; then cat ${quote(nodeFile)}; exit 0; fi\nexit 1\n`, { mode: 0o700 })
  return { root, config: configFrom({ root, homePath: root, nodePath: node, rigPath: rig, tmuxPath: tmux }), setNodes: (rows: unknown[]) => writeFile(nodeFile, JSON.stringify(rows)), online: async () => {
    await mkdir(path.join(root, 'instance'), { recursive: true })
    await writeFile(path.join(root, 'instance', 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port: 43811 }))
    await writeFile(path.join(root, 'online'), '')
  } }
}

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

test('recovery rejects unowned terminal handles before any CLI or terminal creation', async () => {
  const host = mockHost()
  const worker = await mountWorker(workerModule, { host })
  try {
    await assert.rejects(worker.request('terminal.reveal', { terminalId: 'term_not-owned' }), /No saved receipt/)
    await assert.rejects(worker.request('terminal.reveal', { terminalId: 'term_bad;command' }), /Choose a terminal/)
    assert.equal(host.callsOf('terminal.create').length, 0)
    assert.equal(host.callsOf('terminal.sendText').length, 0)
    assert.equal(host.callsOf('workspace.list').length, 0)
  } finally { await worker.deactivate() }
})

test('daemon checks and dashboard preparation cannot start a missing daemon', async () => {
  const fixture = await daemonFixture()
  const host = mockHost({ results: { 'workspace.list': { workspaces: [workspace], truncated: false } }, storage: { 'config.v1': fixture.config } })
  const worker = await mountWorker(workerModule, { host })
  try {
    const state = await worker.request('environment.scan')
    assert.equal(state.snapshot.installed, true)
    assert.equal(state.workspaces[0].project, workspace.project)
    assert.equal(state.daemon.status, 'unavailable')
    await assert.rejects(worker.request('setup.prepare', { action: 'console', workspaceId: workspace.id }), /Start its daemon first/)
    assert.equal(host.callsOf('terminal.create').length, 0)
    await fixture.online()
    const online = await worker.request('environment.scan')
    assert.equal(online.daemon.status, 'reachable')
    assert.equal(host.callsOf('terminal.create').length, 0)
    const plan = await worker.request('setup.prepare', { action: 'console', workspaceId: workspace.id })
    assert.match(plan.command, /tui/)
    assert.equal(plan.command.includes('--shared'), false)
    await rm(path.join(fixture.root, 'online'))
    await assert.rejects(worker.request('setup.execute', { planId: plan.id, workspaceId: workspace.id }), /Cannot read OpenRig seats/)
    assert.equal(host.callsOf('terminal.create').length, 0)
    await assert.rejects(worker.request('setup.execute', { planId: plan.id, workspaceId: workspace.id }), /Prepare a new plan/)
  } finally { await worker.deactivate(); await rm(fixture.root, { recursive: true, force: true }) }
})

test('TUI reviews bind an empty no-agent instance and refuse a changed CLI version', async () => {
  const f = await daemonFixture(), host = mockHost({ results: { 'workspace.list': { workspaces: [workspace], truncated: false } }, storage: { 'config.v1': f.config } }), worker = await mountWorker(workerModule, { host })
  try {
    await f.online()
    const plan = await worker.request('setup.prepare', { action: 'console', workspaceId: workspace.id, consoleSource: 'configured' })
    assert.equal(plan.console?.source, 'configured'); assert.equal(plan.console?.home, await import('node:fs/promises').then(fs => fs.realpath(path.join(f.root, 'instance')))); assert.equal(plan.console?.version, '0.7.13')
    assert.match(plan.command, /export OPENRIG_NO_KERNEL=1/); assert.match(plan.command, /tui/); assert.equal(plan.command.includes('--shared'), false); assert.equal(host.callsOf('terminal.create').length, 0)
    const rig = await readFile(f.config.rigPath, 'utf8'); await writeFile(f.config.rigPath, rig.replace('0.7.13', '0.7.16'), { mode: 0o700 })
    await assert.rejects(worker.request('setup.execute', { planId: plan.id, workspaceId: workspace.id }), /CLI, version or native connection changed/)
    assert.equal(host.callsOf('terminal.create').length, 0)
  } finally { await worker.deactivate(); await rm(f.root, { recursive: true, force: true }) }
})
test('observed-instance TUI review never retargets configured operations and rejects a changed daemon record', async () => {
  const f = await daemonFixture(), host = mockHost({ results: { 'workspace.list': { workspaces: [workspace], truncated: false } }, storage: { 'config.v1': f.config } }), worker = await mountWorker(workerModule, { host })
  try {
    await f.online(); await mkdir(path.join(f.root, '.openrig')); await writeFile(path.join(f.root, '.openrig/daemon.json'), JSON.stringify({ host: '127.0.0.1', port: 17433 }))
    const plan = await worker.request('setup.prepare', { action: 'console', workspaceId: workspace.id, consoleSource: 'tui' })
    assert.equal(plan.console?.port, '17433'); assert.equal(plan.console?.source, 'tui'); assert.match(plan.command, /127\.0\.0\.1:17433/)
    assert.equal(host.callsOf('storage.set').length, 0)
    await writeFile(path.join(f.root, '.openrig/daemon.json'), JSON.stringify({ host: '127.0.0.1', port: 17434 }))
    await assert.rejects(worker.request('setup.execute', { planId: plan.id, workspaceId: workspace.id }), /TUI instance changed/)
    assert.equal(host.callsOf('terminal.create').length, 0)
  } finally { await worker.deactivate(); await rm(f.root, { recursive: true, force: true }) }
})
test('a missing observed TUI instance cannot fall back to the healthy configured instance', async () => {
  const f = await daemonFixture(), host = mockHost({ results: { 'workspace.list': { workspaces: [workspace], truncated: false } }, storage: { 'config.v1': f.config } }), worker = await mountWorker(workerModule, { host })
  try {
    await f.online()
    await assert.rejects(worker.request('setup.prepare', { action: 'console', workspaceId: workspace.id, consoleSource: 'tui' }), /No alternate instance/)
    assert.equal(host.callsOf('terminal.create').length, 0); assert.equal(host.callsOf('storage.set').length, 0)
  } finally { await worker.deactivate(); await rm(f.root, { recursive: true, force: true }) }
})
test('instruction review is read-only and stale or retargeted seats cannot execute it', async () => {
  const row = { rigId: 'rig-1', rigName: 'demo', logicalId: 'dev.worker', canonicalSessionName: 'dev-worker@demo', runtime: 'pi', sessionStatus: 'running', agentActivity: { state: 'idle' } }
  const fixture = await daemonFixture([row])
  const host = mockHost({ results: { 'workspace.list': { workspaces: [workspace], truncated: false } }, storage: { 'config.v1': fixture.config } })
  const worker = await mountWorker(workerModule, { host })
  try {
    await fixture.online()
    const input = { action: 'send-instruction', workspaceId: workspace.id, seatKey: JSON.stringify([row.rigId, row.logicalId]), message: 'Inspect the diff without editing files.' }
    const plan = await worker.request('setup.prepare', input)
    assert.equal(plan.instruction?.session, row.canonicalSessionName)
    assert.equal(plan.instruction?.text, input.message)
    assert.equal(host.callsOf('terminal.create').length, 0)
    await fixture.setNodes([{ ...row, sessionStatus: 'stopped' }])
    await assert.rejects(worker.request('setup.execute', { planId: plan.id, workspaceId: workspace.id }), /no longer available and idle/)
    await assert.rejects(worker.request('setup.execute', { planId: plan.id, workspaceId: workspace.id }), /Prepare a new plan/)
    await fixture.setNodes([row])
    const retargeted = await worker.request('setup.prepare', input)
    await fixture.setNodes([{ ...row, canonicalSessionName: 'another@demo' }])
    await assert.rejects(worker.request('setup.execute', { planId: retargeted.id, workspaceId: workspace.id }), /no longer available and idle/)
    await assert.rejects(worker.request('setup.prepare', { ...input, message: 'inspect\ragain' }), /single line/)
    await assert.rejects(worker.request('setup.prepare', { ...input, seatKey: 'not-in-this-instance' }), /Choose a running/)
    assert.equal(host.callsOf('terminal.create').length, 0)
    assert.equal(host.callsOf('terminal.sendText').length, 0)
  } finally { await worker.deactivate(); await rm(fixture.root, { recursive: true, force: true }) }
})

test('single-seat launch requires consent, leaves running seats alone, and rejects changed definitions', async () => {
  const row = { rigId: 'rig-1', rigName: 'demo', logicalId: 'dev.worker', canonicalSessionName: null, runtime: 'pi', sessionStatus: null, lifecycleState: 'detached', model: null, cwd: '/fixture/project' }
  const fixture = await daemonFixture([row])
  const host = mockHost({ results: { 'workspace.list': { workspaces: [workspace], truncated: false } }, storage: { 'config.v1': fixture.config } })
  const worker = await mountWorker(workerModule, { host })
  try {
    await fixture.online()
    const input = { action: 'launch-seat', workspaceId: workspace.id, seatKey: JSON.stringify([row.rigId, row.logicalId]) }
    const noConsent = await worker.request('setup.prepare', input)
    await assert.rejects(worker.request('setup.execute', { planId: noConsent.id, workspaceId: workspace.id }), /Acknowledge/)
    const raced = await worker.request('setup.prepare', input)
    await fixture.setNodes([{ ...row, sessionStatus: 'running', canonicalSessionName: 'dev-worker@demo' }])
    const result = await worker.request('setup.execute', { planId: raced.id, workspaceId: workspace.id, acceptStartupRisk: true })
    assert.equal('noOp' in result && result.noOp, true)
    await fixture.setNodes([row])
    const changed = await worker.request('setup.prepare', input)
    await fixture.setNodes([{ ...row, model: 'changed-model' }])
    await assert.rejects(worker.request('setup.execute', { planId: changed.id, workspaceId: workspace.id, acceptStartupRisk: true }), /definition or availability changed/)
    await fixture.setNodes([{ ...row, rigName: 'kernel' }])
    await assert.rejects(worker.request('setup.prepare', input), /kernel seats are refused/)
    assert.equal(host.callsOf('terminal.create').length, 0)
  } finally { await worker.deactivate(); await rm(fixture.root, { recursive: true, force: true }) }
})

test('task preparation does not register work and stopped recipients are refused before execution', async () => {
  const row = { rigId: 'rig-1', rigName: 'demo', logicalId: 'dev.worker', canonicalSessionName: 'dev-worker@demo', runtime: 'pi', sessionStatus: 'running', agentActivity: { state: 'working' } }
  const fixture = await daemonFixture([row])
  const host = mockHost({ results: { 'workspace.list': { workspaces: [workspace], truncated: false } }, storage: { 'config.v1': fixture.config } })
  const worker = await mountWorker(workerModule, { host })
  try {
    await fixture.online()
    const plan = await worker.request('setup.prepare', { action: 'create-task', workspaceId: workspace.id, seatKey: JSON.stringify([row.rigId, row.logicalId]), summary: 'Inspect fixture', body: 'Line one\nLine two' })
    assert.ok(plan.queueTask)
    assert.equal((await host.data()).storage[`task:${plan.queueTask!.id}`], undefined)
    await fixture.setNodes([{ ...row, sessionStatus: 'exited' }])
    await assert.rejects(worker.request('setup.execute', { planId: plan.id, workspaceId: workspace.id }), /recipient changed/)
    await assert.rejects(worker.request('task.check', { id: plan.queueTask!.id }), /No saved request/)
    assert.equal(host.callsOf('terminal.create').length, 0)
    assert.equal(host.callsOf('terminal.sendText').length, 0)
  } finally { await worker.deactivate(); await rm(fixture.root, { recursive: true, force: true }) }
})

test('native pod observation and explicit connection affect only plugin-owned routing', async () => {
  const row = { rigId: 'rig-1', rigName: 'demo', logicalId: 'dev.worker', podId: 'pod-1', podNamespace: 'dev', canonicalSessionName: 'dev-worker@demo', runtime: 'pi', sessionStatus: 'running', agentActivity: { state: 'idle' } }
  const fixture = await daemonFixture([row])
  const host = mockHost({ results: { 'workspace.list': { workspaces: [workspace], truncated: false } }, storage: { 'config.v1': fixture.config } })
  const worker = await mountWorker(workerModule, { host })
  try {
    await fixture.online()
    await mkdir(path.join(fixture.root, '.openrig'))
    const file = path.join(fixture.root, '.openrig', 'daemon.json'), original = JSON.stringify({ host: '127.0.0.1', port: 17459 })
    await writeFile(file, original)
    const inventory = await worker.request('pods.list', { source: 'tui' })
    assert.equal(inventory.pods[0].label, 'demo / dev'); assert.equal(inventory.connection.matchesConfigured, false)
    assert.equal((host.data().storage['config.v1'] as any).daemonPort, '43811')
    const connected = await worker.request('pods.connect', { source: 'tui', expectedKey: inventory.connection.key })
    assert.equal(connected.config.daemonPort, '17459'); assert.ok(connected.config.instanceHome.endsWith('/.openrig'))
    assert.equal(await readFile(file, 'utf8'), original)
    assert.equal(host.callsOf('terminal.create').length, 0); assert.equal(host.callsOf('terminal.sendText').length, 0)
  } finally { await worker.deactivate(); await rm(fixture.root, { recursive: true, force: true }) }
})

test('pod-scoped review and attach reject foreign or reassigned seats before creating a terminal', async () => {
  const row = { rigId: 'rig-1', rigName: 'demo', logicalId: 'dev.worker', podId: 'pod-1', podNamespace: 'dev', canonicalSessionName: 'dev-worker@demo', runtime: 'pi', sessionStatus: 'running', agentActivity: { state: 'idle' } }
  const fixture = await daemonFixture([row])
  const host = mockHost({ results: { 'workspace.list': { workspaces: [workspace], truncated: false } }, storage: { 'config.v1': fixture.config } })
  const worker = await mountWorker(workerModule, { host })
  try {
    await fixture.online()
    const inventory = await worker.request('pods.list', { source: 'configured' })
    const input = { action: 'send-instruction', workspaceId: workspace.id, seatKey: JSON.stringify([row.rigId, row.logicalId]), message: 'Inspect fixture', podKey: JSON.stringify([row.rigId, row.podId]), instanceKey: inventory.connection.key }
    await assert.rejects(worker.request('setup.prepare', { ...input, instanceKey: 'f'.repeat(64) }), /different or changed instance/)
    await assert.rejects(worker.request('setup.prepare', { ...input, podKey: '["other","pod-1"]' }), /reviewed pod/)
    const plan = await worker.request('setup.prepare', input)
    assert.equal(plan.pod?.key, input.podKey)
    await fixture.setNodes([{ ...row, podId: 'pod-2', podNamespace: 'other' }])
    await assert.rejects(worker.request('setup.execute', { planId: plan.id, workspaceId: workspace.id }), /no longer available/)
    await assert.rejects(worker.request('seat.attach', { key: input.seatKey, workspaceId: workspace.id, readOnly: true, podKey: input.podKey, instanceKey: input.instanceKey }), /selected pod/)
    assert.equal(host.callsOf('terminal.create').length, 0)
  } finally { await worker.deactivate(); await rm(fixture.root, { recursive: true, force: true }) }
})

test('remote workspace is rejected before discovering or executing local tools', async () => {
  const host = mockHost({ results: { 'workspace.list': { workspaces: [{ ...workspace, hostId: 'remote-host' }], truncated: false } } })
  const worker = await mountWorker(workerModule, { host })
  await assert.rejects(worker.request('setup.prepare', { action: 'install-rig', workspaceId: workspace.id }), /local Orca workspace/)
  assert.equal(host.callsOf('terminal.create').length, 0)
  await worker.deactivate()
})
