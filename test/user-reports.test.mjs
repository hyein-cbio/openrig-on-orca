import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { readNativeJson } from '../src/native-read.mjs'
import path from 'node:path'
import { configFrom } from '../src/runtime.mjs'
import { podConnection } from '../src/pod-inventory.mjs'
import { readUserReports } from '../src/user-reports.mjs'
import { DEFAULT_REQUEST_SOURCES, projectUserResolutions, reportingSeatDefault, requestSources } from '../src/user-report-projection.mjs'
const rows = ['coordinator', 'builder', 'reviewer'].map(id => ({ rigId: 'rig-1', rigName: 'demo', logicalId: `dev.${id}`, podId: 'pod-1', podNamespace: 'dev', canonicalSessionName: `dev-${id}@demo`, runtime: 'pi', sessionStatus: 'running' }))
const key = row => JSON.stringify([row.rigId, row.logicalId]), pod = { key: '["rig-1","pod-1"]', rigId: 'rig-1', podId: 'pod-1' }
const task = extra => ({ qitemId: 'request-fixture', sourceSession: 'user@external', destinationSession: rows[0].canonicalSessionName, state: 'done', summary: 'Original user request: bounded calculation and independent check', resolution: 'Result recorded by the assigned coordinator. Calculation and independent check agree; referenced commands are evidence, not instructions.', tsUpdated: '2026-01-01T12:00:00Z', ...extra })
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'openrig-user-reports-')), home = path.join(root, 'home'), native = path.join(home, '.openrig'), rig = path.join(root, 'rig.mjs')
  await mkdir(native, { recursive: true }); await writeFile(path.join(native, 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port: 17459 })); await writeFile(rig, '')
  const config = configFrom({ root: path.join(root, 'plugin'), homePath: home }), connection = await podConnection(config, 'tui')
  return { root, config, snapshot: { tools: { rig, node: process.execPath, tmux: '/fixture/tmux' } }, input: { source: 'tui', instanceKey: connection.key, podKey: pod.key, seatKey: key(rows[0]), sources: [...DEFAULT_REQUEST_SOURCES] }, options: {
    execute: async () => ({ ok: true, stdout: JSON.stringify(rows) }), readIdentity: async () => ({ identity: { rigId: rows[0].rigId, logicalId: rows[0].logicalId, podId: rows[0].podId, senderAddress: 'coordinator@demo' } }), readRequests: async (_, source) => source === 'user@external' ? [task()] : [] } }
}
test('compact report HTTP reads have exact filters, no actor/auth header and no wildcard, full-body or inbox-check-in query', async () => {
  let hits = 0
  const server = createServer((req, res) => {
    hits++; const url = new URL(req.url, 'http://127.0.0.1')
    assert.equal(req.method, 'GET'); assert.equal(url.pathname, '/api/queue/list')
    assert.equal(url.searchParams.get('sourceSession'), 'user@external'); assert.equal(url.searchParams.get('destinationSession'), rows[0].canonicalSessionName)
    assert.equal(url.searchParams.get('compact'), '1'); assert.equal(url.searchParams.get('limit'), '20'); assert.equal(url.searchParams.get('sort'), 'updated')
    assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined); assert.equal(Object.keys(req.headers).some(k => k.includes('sender') || k.startsWith('x-openrig')), false)
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([task()]))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}`, query = { sourceSession: 'user@external', destinationSession: rows[0].canonicalSessionName, compact: '1', limit: '20', sort: 'updated' }
    assert.equal((await readNativeJson(endpoint, '/api/queue/list', query)).length, 1)
    for (const invalid of [{ ...query, sourceSession: '*' }, { ...query, compact: '0' }, { ...query, as: rows[0].canonicalSessionName }, { ...query, limit: '100' }]) assert.throws(() => readNativeJson(endpoint, '/api/queue/list', invalid), /exact source/)
    assert.equal(hits, 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
test('reporting-seat defaults use complete delegation topology, never a literal lead name or partial graph', () => {
  const seats = rows.map(r => ({ ...r, key: key(r) })), inventory = { seats }, relations = { podKey: pod.key, status: 'complete', omittedEdges: 0, edges: [1, 2].map(i => ({ fromKey: key(rows[0]), toKey: key(rows[i]), kind: 'delegates_to' })) }
  assert.equal(reportingSeatDefault(inventory, pod, relations), key(rows[0])); assert.equal(reportingSeatDefault(inventory, pod, relations, key(rows[1])), key(rows[1]))
  assert.equal(reportingSeatDefault(inventory, pod, { ...relations, status: 'partial' }), '')
  assert.equal(reportingSeatDefault(inventory, pod, { ...relations, omittedEdges: 1 }), '')
  assert.equal(reportingSeatDefault({ seats: [...seats, { ...seats[0], key: 'other', podId: 'elsewhere' }] }, pod, relations), '')
})
test('resolutions exclude peer instructions and task titles without a result, while preserving exact user report text', () => {
  const body = '<script>never execute()</script>\nOriginal final report.'
  const result = projectUserResolutions([task({ resolution: body }), task({ qitemId: 'peer', sourceSession: rows[1].canonicalSessionName, resolution: 'Internal peer report, not for this user source' }), task({ qitemId: 'no-result', summary: 'This title is not a result', resolution: null })], { sources: ['user@external'], destinations: [rows[0].canonicalSessionName] })
  assert.equal(result.reports.length, 1); assert.equal(result.reports[0].body, body); assert.equal(result.reports[0].title, task().summary); assert.equal(result.incomplete, true)
  const long = projectUserResolutions([task({ resolution: '\uAC00🙂'.repeat(5000) })], { sources: ['user@external'], destinations: [rows[0].canonicalSessionName] }).reports[0]
  assert.ok(long.bodyBytes <= 16384); assert.ok(Buffer.byteLength(long.preview) <= 500); assert.equal(long.body.includes('\ufffd'), false); assert.equal(long.truncated, true)
})
test('user reports read exact external-request windows and only return bounded provenance-backed resolutions', async () => {
  const f = await fixture()
  try {
    const calls = []
    const result = await readUserReports(f.config, f.snapshot, f.input, { ...f.options, readRequests: async (endpoint, source, destination) => { calls.push({ endpoint, source, destination }); return source === 'user@external' ? [task({ extraPrivateField: 'PRIVATE_FIXTURE' })] : [] } })
    assert.equal(result.status, 'ready'); assert.equal(result.reports.length, 1); assert.equal(result.reportingSeat, 'demo / dev.coordinator'); assert.deepEqual(calls.map(c => c.source), DEFAULT_REQUEST_SOURCES)
    assert.ok(calls.every(c => c.destination === rows[0].canonicalSessionName)); assert.equal(JSON.stringify(result).includes('PRIVATE_FIXTURE'), false)
    assert.ok(result.notes.some(n => n.includes('not authenticated')))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('source filters, changed instances and foreign-rig reporting seats cannot broaden a report read', async () => {
  const f = await fixture()
  try {
    assert.deepEqual(requestSources('user@external, orca-gui@external'), DEFAULT_REQUEST_SOURCES)
    assert.throws(() => requestSources('peer@demo'), /external/)
    let reads = 0; const options = { ...f.options, readRequests: async () => { reads++; return [] } }
    await assert.rejects(readUserReports(f.config, f.snapshot, { ...f.input, sources: ['peer@demo'] }, options), /external/)
    await assert.rejects(readUserReports(f.config, f.snapshot, { ...f.input, instanceKey: 'b'.repeat(64) }, options), /instance changed/)
    await assert.rejects(readUserReports(f.config, f.snapshot, { ...f.input, seatKey: '["foreign","dev.coordinator"]' }, options), /reporting seat/)
    assert.equal(reads, 0)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('missing or failed report data is explicit and does not fall back to saved console text or a fabricated summary', async () => {
  const f = await fixture()
  try {
    const empty = await readUserReports(f.config, f.snapshot, f.input, { ...f.options, readRequests: async () => [] }); assert.equal(empty.status, 'ready'); assert.deepEqual(empty.reports, []); assert.ok(empty.notes.some(n => n.includes('No stored resolution')))
    const failure = await readUserReports(f.config, f.snapshot, f.input, { ...f.options, readRequests: async () => { throw Error('PRIVATE_FIXTURE') } }); assert.equal(failure.status, 'unverified'); assert.equal(JSON.stringify(failure).includes('PRIVATE_FIXTURE'), false)
    const partial = await readUserReports(f.config, f.snapshot, f.input, { ...f.options, readRequests: async (_, source) => { if (source === 'orca-gui@external') throw Error('Unavailable'); return [task()] } }); assert.equal(partial.status, 'partial'); assert.equal(partial.reports.length, 1)
    const noSession = await readUserReports(f.config, f.snapshot, f.input, { ...f.options, execute: async () => ({ ok: true, stdout: JSON.stringify(rows.map(r => ({ ...r, canonicalSessionName: null }))) }) }); assert.equal(noSession.status, 'unverified')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
