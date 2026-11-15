import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { configFrom } from '../src/runtime.mjs'
import { podConnection } from '../src/pod-inventory.mjs'
import { readSeatReport } from '../src/seat-reports.mjs'
import { readNativeJson } from '../src/native-read.mjs'
import { createServer } from 'node:http'
import { reportPrefix } from '../src/report-preview.mjs'
const rows = ['lead', 'builder'].map(id => ({ rigId: 'rig-1', rigName: 'demo', logicalId: `dev.${id}`, podId: 'pod-1', podNamespace: 'dev', canonicalSessionName: `dev-${id}@demo`, runtime: 'pi', sessionStatus: 'running' }))
const identity = (row = rows[0]) => ({ identity: { rigId: row.rigId, logicalId: row.logicalId, podId: row.podId, senderAddress: row.logicalId === 'dev.lead' ? 'lead@demo' : 'builder@demo' } })
const record = extra => ({ outboxId: 'outbox-fixture', senderSession: rows[0].canonicalSessionName, destinationSession: rows[1].canonicalSessionName, body: 'Native outbound text', tsDispatched: '2026-01-01T12:00:00Z', deliveryState: 'indeterminate', tags: null, ...extra })
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'openrig-report-preview-')), home = path.join(root, 'home'), native = path.join(home, '.openrig'), rig = path.join(root, 'rig.mjs')
  await mkdir(native, { recursive: true }); await writeFile(path.join(native, 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port: 17459 })); await writeFile(rig, '')
  const config = configFrom({ root: path.join(root, 'plugin'), homePath: home }), connection = await podConnection(config, 'tui')
  return { root, config, snapshot: { tools: { rig, node: process.execPath, tmux: '/fixture/tmux' } }, input: { source: 'tui', instanceKey: connection.key, podKey: JSON.stringify(['rig-1', 'pod-1']), seatKey: JSON.stringify(['rig-1', 'dev.lead']) }, options: { execute: async () => ({ ok: true, stdout: JSON.stringify(rows) }), readIdentity: async () => identity(), readOutbox: async () => [record()] } }
}
test('outbox HTTP reads are fixed-route GETs with sender/limit filters and no credentials or redirects', async () => {
  let hits = 0
  const server = createServer((req, res) => {
    hits++; const url = new URL(req.url, 'http://127.0.0.1')
    assert.equal(req.method, 'GET'); assert.equal(url.pathname, '/api/queue/outbox/list'); assert.equal(url.searchParams.get('senderSession'), rows[0].canonicalSessionName); assert.equal(url.searchParams.get('limit'), '20')
    assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined)
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([record()]))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await readNativeJson(endpoint, '/api/queue/outbox/list', { senderSession: rows[0].canonicalSessionName, limit: 20 }, undefined, 1048576)).length, 1)
    assert.throws(() => readNativeJson(endpoint, '/api/transcript', {}), /bounded/)
    assert.throws(() => readNativeJson(endpoint, '/api/whoami', {}), /compact/)
    assert.equal(hits, 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
test('500-byte excerpts preserve valid UTF-8, exact prefixes and separate truncation metadata', () => {
  for (const body of ['a'.repeat(900), '\uAC00'.repeat(300), '🙂'.repeat(200), 'a'.repeat(498) + '🙂tail', '\ufeff' + '\uBCF4\uACE0'.repeat(150), '<script>unsafe()</script>\nraw']) {
    const result = reportPrefix(body)
    assert.ok(result.previewBytes <= 500); assert.equal(new TextEncoder().encode(result.preview).length, result.previewBytes)
    assert.equal(body.startsWith(result.preview), true); assert.equal(result.preview.includes('\ufffd'), false)
    assert.equal(result.totalBytes, new TextEncoder().encode(body).length); assert.equal(result.truncated, result.totalBytes > result.previewBytes)
  }
  assert.equal(reportPrefix('a'.repeat(498) + '🙂').previewBytes, 498)
  assert.equal(reportPrefix('\uAC00'.repeat(300)).previewBytes, 498)
})
test('preview is the latest eligible recorded outbound body, not incoming/system text or an LLM summary', async () => {
  const f = await fixture()
  try {
    const body = '\uBCF4\uACE0🙂'.repeat(200)
    const result = await readSeatReport(f.config, f.snapshot, f.input, { ...f.options, readOutbox: async () => [record({ tsDispatched: '2026-01-01T13:00:00Z', tags: ['queue:auto-unpark:blocker'], body: 'Automated wake' }), record({ body }), record({ tsDispatched: '2026-01-01T11:00:00Z', body: 'Old message' })] })
    assert.equal(result.status, 'recorded'); assert.equal(result.recipient, 'demo / dev.builder'); assert.equal(result.delivery, 'indeterminate')
    assert.equal(result.preview, reportPrefix(body).preview); assert.equal(result.truncated, true)
    assert.equal(JSON.stringify(result).includes(body), false); assert.match(result.detail, /not an LLM/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('native sender and recipient aliases are resolved, never guessed from names', async () => {
  const f = await fixture()
  try {
    const result = await readSeatReport(f.config, f.snapshot, f.input, { ...f.options, readOutbox: async () => [record({ senderSession: 'lead@demo', destinationSession: 'builder@demo' })], readIdentity: async (_, session) => identity(session === 'builder@demo' ? rows[1] : rows[0]) })
    assert.equal(result.status, 'recorded'); assert.equal(result.recipient, 'demo / dev.builder')
    const wrong = await readSeatReport(f.config, f.snapshot, f.input, { ...f.options, readOutbox: async () => [record({ senderSession: 'foreign@elsewhere', body: 'WRONG_SENDER_FIXTURE' })] })
    assert.equal(wrong.status, 'unverified'); assert.equal(JSON.stringify(wrong).includes('WRONG_SENDER_FIXTURE'), false)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('no record is scoped to a bounded window; unknown identities and unavailable histories remain unverified', async () => {
  const f = await fixture()
  try {
    const none = await readSeatReport(f.config, f.snapshot, f.input, { ...f.options, readOutbox: async () => [] })
    assert.equal(none.status, 'none'); assert.match(none.detail, /not proof/)
    const bounded = await readSeatReport(f.config, f.snapshot, f.input, { ...f.options, readOutbox: async () => Array.from({ length: 20 }, () => record({ destinationSession: 'human@external' })) })
    assert.equal(bounded.status, 'unverified')
    const failure = await readSeatReport(f.config, f.snapshot, f.input, { ...f.options, readOutbox: async () => { throw Error('PRIVATE_FIXTURE') } })
    assert.equal(failure.status, 'unverified'); assert.equal(JSON.stringify(failure).includes('PRIVATE_FIXTURE'), false)
    const mismatch = await readSeatReport(f.config, f.snapshot, f.input, { ...f.options, readIdentity: async () => ({ identity: { ...identity().identity, rigId: 'foreign' } }) })
    assert.equal(mismatch.status, 'unverified')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('sessionless and foreign-pod/instance previews never read report contents', async () => {
  const f = await fixture()
  try {
    let reads = 0
    const options = { ...f.options, readOutbox: async () => { reads++; return [] } }
    await assert.rejects(readSeatReport(f.config, f.snapshot, { ...f.input, instanceKey: 'f'.repeat(64) }, options), /observed instance/)
    await assert.rejects(readSeatReport(f.config, f.snapshot, { ...f.input, podKey: '["foreign","pod"]' }, options), /hovered seat/)
    const result = await readSeatReport(f.config, f.snapshot, f.input, { ...options, execute: async () => ({ ok: true, stdout: JSON.stringify(rows.map(r => ({ ...r, canonicalSessionName: null }))) }) })
    assert.equal(result.status, 'unverified'); assert.equal(reads, 0)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
