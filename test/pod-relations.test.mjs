import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { configFrom } from '../src/runtime.mjs'
import { podConnection } from '../src/pod-inventory.mjs'
import { readCompactWhoami, readPodRelations } from '../src/pod-relations.mjs'
import { podsFromSeats, topologyForPod } from '../src/pods.mjs'

const rows = ['lead', 'builder'].map(id => ({ rigId: 'rig-1', rigName: 'fixture', logicalId: `dev.${id}`, podId: 'pod-1', podNamespace: 'dev', canonicalSessionName: `dev-${id}@fixture`, runtime: 'pi', sessionStatus: 'running', agentActivity: { state: 'idle' } }))
const key = logical => JSON.stringify(['rig-1', logical])
const edge = { kind: 'delegates_to', to: { logicalId: 'dev.builder' } }
const data = logical => ({ identity: { rigId: 'rig-1', logicalId: logical, podId: 'pod-1' }, edges: { outgoing: logical === 'dev.lead' ? [edge] : [], incoming: logical === 'dev.builder' ? [{ kind: 'delegates_to', from: { logicalId: 'dev.lead' } }] : [] }, ignored: 'PRIVATE_FIXTURE' })
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'openrig-pod-edges-')), home = path.join(root, 'home'), native = path.join(home, '.openrig'), rig = path.join(root, 'rig.mjs')
  await mkdir(native, { recursive: true }); await writeFile(path.join(native, 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port: 17459 })); await writeFile(rig, '')
  const config = configFrom({ root: path.join(root, 'plugin'), homePath: home }), snapshot = { tools: { rig, node: process.execPath, tmux: '/fixture/tmux' } }, connection = await podConnection(config, 'tui')
  return { root, config, snapshot, input: { source: 'tui', instanceKey: connection.key, podKey: JSON.stringify(['rig-1', 'pod-1']) }, execute: async () => ({ ok: true, stdout: JSON.stringify(rows) }) }
}
test('compact native incidence is deduplicated into directed same-pod edges without private fields', async () => {
  const f = await fixture()
  try {
    const seen = []
    const result = await readPodRelations(f.config, f.snapshot, f.input, { execute: f.execute, read: async (endpoint, session) => { seen.push(session); return data(session === rows[0].canonicalSessionName ? 'dev.lead' : 'dev.builder') } })
    assert.equal(result.status, 'complete'); assert.equal(seen.length, 2)
    assert.deepEqual(result.edges, [{ fromKey: key('dev.lead'), toKey: key('dev.builder'), kind: 'delegates_to' }])
    assert.equal(JSON.stringify(result).includes('PRIVATE_FIXTURE'), false)
    const seats = rows.map(r => ({ ...r, key: key(r.logicalId), status: 'running', activity: 'idle' }))
    const graph = topologyForPod(podsFromSeats(seats)[0], seats, 123, result)
    assert.deepEqual(graph.edges, [{ from: 'agent_0', to: 'agent_1', kind: 'delegates_to' }]); assert.equal(graph.relationsStatus, 'complete')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('never-started, failed or identity-mismatched reads remain partial/unknown, not no-connection claims', async () => {
  const f = await fixture()
  try {
    let calls = 0
    const missing = await readPodRelations(f.config, f.snapshot, f.input, { execute: async () => ({ ok: true, stdout: JSON.stringify([rows[0], { ...rows[1], canonicalSessionName: null }]) }), read: async () => { calls++; return data('dev.lead') } })
    assert.equal(calls, 1); assert.equal(missing.status, 'partial'); assert.equal(missing.edges.length, 1)
    assert.ok(missing.notes.some(n => n.includes('no canonical session')))
    const failed = await readPodRelations(f.config, f.snapshot, f.input, { execute: f.execute, read: async () => { throw Error('PRIVATE_FIXTURE') } })
    assert.equal(failed.status, 'unavailable'); assert.deepEqual(failed.edges, []); assert.equal(JSON.stringify(failed).includes('PRIVATE_FIXTURE'), false)
    const wrong = await readPodRelations(f.config, f.snapshot, f.input, { execute: f.execute, read: async () => ({ ...data('dev.lead'), identity: { ...data('dev.lead').identity, rigId: 'foreign' } }) })
    assert.equal(wrong.status, 'unavailable')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('cross-pod endpoints are omitted explicitly and disagreements/building are partial', async () => {
  const f = await fixture()
  try {
    const result = await readPodRelations(f.config, f.snapshot, f.input, { execute: f.execute, read: async (_, session) => session === rows[0].canonicalSessionName ? { ...data('dev.lead'), edges: { outgoing: [edge, { kind: 'can_observe', to: { logicalId: 'other.worker' } }], incoming: [] } } : { ...data('dev.builder'), rosterState: 'building', edges: { outgoing: [], incoming: [] } } })
    assert.equal(result.status, 'partial'); assert.equal(result.edges.length, 1); assert.equal(result.omittedEdges, 1)
    assert.ok(result.notes.some(n => n.includes('outside this selected pod')))
    const zero = await readPodRelations(f.config, f.snapshot, f.input, { execute: f.execute, read: async (_, s) => ({ ...data(s === rows[0].canonicalSessionName ? 'dev.lead' : 'dev.builder'), edges: { outgoing: [], incoming: [] } }) })
    assert.equal(zero.status, 'complete'); assert.deepEqual(zero.edges, []); assert.ok(zero.notes.some(n => n.includes('no same-pod relationships')))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('changed instance and unknown pod refuse relationship HTTP reads', async () => {
  const f = await fixture()
  try {
    let reads = 0; const options = { execute: f.execute, read: async () => { reads++; return data('dev.lead') } }
    await assert.rejects(readPodRelations(f.config, f.snapshot, { ...f.input, instanceKey: 'f'.repeat(64) }, options), /instance changed/)
    await assert.rejects(readPodRelations(f.config, f.snapshot, { ...f.input, podKey: '["other","pod-1"]' }, options), /no longer/)
    assert.equal(reads, 0)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('compact HTTP is bounded GET-only loopback without credentials, redirects or transcript requests', async () => {
  let mode = 'ok', hits = 0
  const server = createServer((req, res) => {
    hits++; assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined)
    const url = new URL(req.url, 'http://127.0.0.1'); assert.equal(url.pathname, '/api/whoami'); assert.equal(url.searchParams.get('compact'), '1'); assert.equal(url.searchParams.get('sessionName'), 'dev-lead@fixture')
    if (mode === 'redirect') { res.writeHead(302, { Location: '/private' }); res.end(); return }
    res.setHeader('Content-Type', 'application/json'); res.end(mode === 'large' ? 'x'.repeat(262145) : JSON.stringify(data('dev.lead')))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await readCompactWhoami(endpoint, 'dev-lead@fixture')).identity.logicalId, 'dev.lead')
    mode = 'redirect'; await assert.rejects(readCompactWhoami(endpoint, 'dev-lead@fixture')); assert.equal(hits, 2)
    mode = 'large'; await assert.rejects(readCompactWhoami(endpoint, 'dev-lead@fixture'))
    assert.throws(() => readCompactWhoami('http://remote.invalid', 'dev-lead@fixture'), /loopback/)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
