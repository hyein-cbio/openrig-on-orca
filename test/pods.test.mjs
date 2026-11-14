import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { configFrom } from '../src/runtime.mjs'
import { podConnection, readPodInventory, connectedPodConfig, assertPodInstance } from '../src/pod-inventory.mjs'
import { podsFromSeats, podKeyOf, seatInPod, topologyForPod } from '../src/pods.mjs'
const row = { rigId: 'rig-1', rigName: 'demo', logicalId: 'dev.lead', podId: 'pod-1', podNamespace: 'dev', canonicalSessionName: 'dev-lead@demo', runtime: 'pi', model: 'declared-model', sessionStatus: 'running', lifecycleState: 'running', agentActivity: { state: 'idle' }, ignoredPrivateField: 'PRIVATE_FIXTURE' }
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'openrig-native-pods-')), home = path.join(root, 'home'), native = path.join(home, '.openrig'), rig = path.join(root, 'rig.mjs')
  await mkdir(native, { recursive: true }); await writeFile(path.join(native, 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port: 17459 })); await writeFile(rig, '')
  return { root, native, config: configFrom({ root: path.join(root, 'plugin'), homePath: home, daemonPort: '43811' }), snapshot: { tools: { rig, node: process.execPath, tmux: '/fixture/tmux' } } }
}
test('native pod reads use the daemon record and projected metadata, not an Orca workspace or ambient host', async () => {
  const f = await fixture()
  try {
    let calls = 0
    const observed = await readPodInventory(f.config, f.snapshot, 'tui', async (file, args, options) => {
      calls++; assert.equal(options.env.OPENRIG_HOME, await realpath(f.native)); assert.equal(options.env.OPENRIG_URL, 'http://127.0.0.1:17459'); assert.equal(options.env.OPENRIG_HOST_SELECTED, 'local')
      assert.ok(args.includes('--no-cleanup'))
      const fields = args[args.indexOf('--fields') + 1].split(','); assert.ok(fields.includes('podId') && fields.includes('podNamespace')); assert.equal(fields.includes('resumeToken'), false)
      return { ok: true, stdout: JSON.stringify({ entries: [row] }) }
    }, { HOME: '/not-the-selected-home', RIGGED_URL: 'http://127.0.0.1:1', OPENRIG_HOST_SELECTED: 'remote' })
    assert.equal(calls, 1); assert.equal(observed.pods[0].label, 'demo / dev'); assert.equal(observed.pods[0].seatCount, 1)
    assert.equal(observed.connection.matchesConfigured, false); assert.equal(observed.seats[0].cwd, null)
    assert.equal(JSON.stringify(observed).includes('PRIVATE_FIXTURE'), false)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('explicit connection changes only the returned plugin routing and rejects a changed observation', async () => {
  const f = await fixture()
  try {
    const file = path.join(f.native, 'daemon.json'), before = await readFile(file, 'utf8'), connection = await podConnection(f.config, 'tui')
    const next = await connectedPodConfig(f.config, 'tui', connection.key)
    assert.equal(next.instanceHome, await realpath(f.native)); assert.equal(next.daemonPort, '17459'); assert.equal(f.config.instanceHome, '')
    assert.equal(await readFile(file, 'utf8'), before)
    assert.equal((await podConnection(next, 'tui')).matchesConfigured, true)
    await assertPodInstance(next, connection.key)
    const clone = path.join(f.root, 'cloned-instance'); await mkdir(clone); await writeFile(path.join(clone, 'daemon.json'), before)
    await assert.rejects(assertPodInstance(configFrom({ ...next, instanceHome: clone }), connection.key), /different or changed instance/)
    await writeFile(file, JSON.stringify({ host: '127.0.0.1', port: 17460 }))
    await assert.rejects(connectedPodConfig(f.config, 'tui', connection.key), /changed/)
    await assert.rejects(podConnection(next, 'configured'), /port differs/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('unavailable, remote, malformed or truncated observations are never treated as empty pod lists', async () => {
  const f = await fixture()
  try {
    await assert.rejects(podConnection(f.config, 'configured'), /No readable daemon/)
    await assert.rejects(podConnection(f.config, 'remote'), /Choose the default/)
    for (const payload of [{ entries: [], truncated: true }, { entries: [{ ...row, podId: undefined }] }, { entries: [{ ...row, rigId: undefined }] }, { entries: [row, row] }]) {
      await assert.rejects(readPodInventory(f.config, f.snapshot, 'tui', async () => ({ ok: true, stdout: JSON.stringify(payload) })))
    }
    const empty = await readPodInventory(f.config, f.snapshot, 'tui', async () => ({ ok: true, stdout: '[]' }))
    assert.deepEqual(empty.pods, [])
    await writeFile(path.join(f.native, 'daemon.json'), JSON.stringify({ host: 'remote.example', port: 17459 }))
    await assert.rejects(podConnection(f.config, 'tui'), /loopback/)
    await writeFile(path.join(f.native, 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port: 17459, padding: 'x'.repeat(16384) }))
    await assert.rejects(podConnection(f.config, 'tui'), /No readable daemon/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('pod identity is rig-scoped even for duplicate namespaces; missing group data is not guessed', () => {
  const a = { ...row, key: '["rig-1","dev.lead"]', session: row.canonicalSessionName, status: 'running', activity: 'idle', attention: false }
  const b = { ...a, rigId: 'rig-2', rigName: 'other', key: '["rig-2","dev.lead"]' }
  const pods = podsFromSeats([a, b]); assert.equal(pods.length, 2); assert.notEqual(pods[0].key, pods[1].key)
  assert.equal(seatInPod(a, pods.find(p => p.rigId === a.rigId)), true); assert.equal(seatInPod(a, pods.find(p => p.rigId === b.rigId)), false)
  assert.equal(podKeyOf({ ...a, podId: undefined }), null); assert.equal(podKeyOf({ ...a, podId: '' }), null)
  assert.throws(() => podsFromSeats(Array.from({ length: 513 }, (_, i) => ({ ...a, key: `seat-${i}` }))), /512/)
  assert.throws(() => podsFromSeats(Array.from({ length: 129 }, (_, i) => ({ ...a, key: `seat-${i}`, podId: `pod-${i}`, podNamespace: `p-${i}` }))), /128/)
  assert.throws(() => topologyForPod(pods.find(p => p.rigId === a.rigId), Array.from({ length: 81 }, (_, i) => ({ ...a, key: `seat-${i}` })), 0), /80 seats/)
  assert.match(podsFromSeats([{ ...a, podId: null, podNamespace: null }])[0].label, /unassigned/)
  const graph = topologyForPod(pods.find(p => p.rigId === a.rigId), [a, b], 123)
  assert.equal(graph.nodes.length, 1); assert.equal(graph.nodes[0].status, 'running'); assert.equal(graph.nodes[0].activity, 'idle'); assert.deepEqual(graph.edges, [])
  assert.ok(graph.warnings.some(s => s.includes('not queried')))
})
