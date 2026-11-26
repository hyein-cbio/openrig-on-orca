import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendFile, mkdtemp, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { projectPiRecord, readPiLiveTail } from './pi-live-tail'
import { PiLiveSessions } from './pi-live-session'
import { createPiLiveController } from './pi-live-controller'
import type { PiLiveBatch, PiLiveScope } from './protocol'

const line = (value: unknown) => `${JSON.stringify(value)}\n`
const header = line({ type: 'session', version: 3, id: 'fixture' })
const msg = (role: string, body: object) => ({ type: 'message', timestamp: '2026-01-01T00:00:00.000Z', message: { role, ...body } })
const user = (content: string) => line(msg('user', { content }))
const signal = () => new AbortController().signal
async function fixture<T>(fn: (file: string, identity: { file: string; dev: string; ino: string }) => Promise<T>) {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-live-pi-'))
  try {
    const file = path.join(root, 'seat.jsonl')
    await writeFile(file, header)
    const { dev, ino } = await stat(file)
    return await fn(file, { file, dev: String(dev), ino: String(ino) })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('Pi Live projects typed rows, excludes system/tool details and substitutes images', () => {
  const projected = projectPiRecord(msg('assistant', { model: 'pi-model', content: [
    { type: 'thinking', thinking: 'inspect' }, { type: 'text', text: 'Answer' },
    { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md', private: 'omit' } }
  ] }), 13)
  assert.deepEqual(projected.map(({ kind, title, text, toolId }) => [kind, title, text, toolId]), [['thinking', 'Thinking', 'inspect', undefined], ['assistant', 'pi-model', 'Answer', undefined], ['tool', 'read', 'README.md', 'call-1']])
  assert.deepEqual(projectPiRecord(msg('system', { content: 'private' }), 0), [])
  const result = projectPiRecord(msg('toolResult', { toolCallId: 'call-1', isError: true, details: { key: 'not sent' }, content: [{ type: 'image', data: 'not sent' }, { type: 'text', text: 'failure' }] }), 99)[0]
  assert.equal(result.toolId, 'call-1'); assert.equal(result.error, true); assert.equal(result.text, '[Image omitted]\nfailure')
})

test('Pi Live retains omission and interruption notices within the row budget', () => {
  const content = Array.from({ length: 8 }, (_, i) => ({ type: 'text', text: `block ${i}` }))
  const rows = projectPiRecord(msg('assistant', { content, stopReason: 'aborted' }), 1)
  assert.deepEqual(rows.map(row => row.kind), ['assistant', 'assistant', 'assistant', 'assistant', 'marker', 'error'])
  assert.equal(rows.at(-1)?.title, 'Response interrupted')
  assert.deepEqual(projectPiRecord(msg('assistant', { content: [...content.slice(0, 5), { type: 'text', text: ' ' }], stopReason: 'aborted' }), 2).map(row => row.kind), ['assistant', 'assistant', 'assistant', 'assistant', 'assistant', 'error'])
})

test('Pi Live tail commits only complete records, including split multibyte data, without rereading a committed row', () => fixture(async (file, identity) => {
  const initial = await readPiLiveTail(identity, null, signal()); assert.deepEqual(initial.events, [])
  const message = '\uD55C\uAE00 \u{1F41A}'
  const item = Buffer.from(user(message))
  const split = item.indexOf(Buffer.from('\u{1F41A}')) + 2
  await appendFile(file, item.subarray(0, split))
  const partial = await readPiLiveTail(identity, initial.cursor, signal()); assert.deepEqual(partial.events, []); assert.equal(partial.cursor.offset, initial.cursor.offset)
  await appendFile(file, item.subarray(split))
  const complete = await readPiLiveTail(identity, partial.cursor, signal()); assert.deepEqual(complete.events.map(e => e.text), [message]); assert.equal(complete.cursor.offset, Buffer.byteLength(header) + item.length)
  assert.deepEqual((await readPiLiveTail(identity, complete.cursor, signal())).events, [])
  assert.equal(await readFile(file, 'utf8'), header + item.toString('utf8'))
}))

test('Pi Live starts at a recent bounded range, discloses omitted/malformed records, and drains capped batches', () => fixture(async (file, identity) => {
  await appendFile(file, user('old record') + 'X'.repeat(150_000) + '\n' + 'invalid json\n' + Array.from({ length: 50 }, (_, i) => user(`row ${i}`)).join(''))
  let result = await readPiLiveTail(identity, null, signal())
  assert.equal(result.omittedHistory, true); assert.equal(result.skippedRecords, 1); assert.equal(result.events.length, 24)
  const output = result.events.map(e => e.text)
  for (let batches = 1; result.more && batches < 4; batches++) {
    result = await readPiLiveTail(identity, result.cursor, signal()); output.push(...result.events.map(e => e.text)); assert.ok(output.length <= 50)
  }
  assert.equal(result.more, false, 'The bounded drain must advance through the fixture')
  assert.deepEqual(output, Array.from({ length: 50 }, (_, i) => `row ${i}`))
}))

test('Pi Live skips a huge append by byte budget and recovers at its newline', () => fixture(async (file, identity) => {
  const initial = await readPiLiveTail(identity, null, signal())
  await appendFile(file, 'x'.repeat(290_000))
  const huge = await readPiLiveTail(identity, initial.cursor, signal())
  assert.equal(huge.skippedRecords, 1); assert.equal(huge.cursor.skipping, true); assert.equal(huge.more, true)
  await appendFile(file, '\n' + user('aligned'))
  const next = await readPiLiveTail(identity, huge.cursor, signal())
  assert.equal(next.skippedRecords, 0); assert.deepEqual(next.events.map(e => e.text), ['aligned']); assert.equal(next.more, false)
}))

test('Pi Live rejects replacement, truncation, and a changed checkpoint even when the file grows', async () => {
  await fixture(async (file, identity) => {
    await appendFile(file, user('original'))
    const initial = await readPiLiveTail(identity, null, signal())
    await writeFile(file, header + user('modified') + user('new'))
    await assert.rejects(readPiLiveTail(identity, initial.cursor, signal()), /history changed/)
    await truncate(file, 2)
    await assert.rejects(readPiLiveTail(identity, initial.cursor, signal()), /history changed/)
  })
  await fixture(async (file, identity) => {
    const initial = await readPiLiveTail(identity, null, signal())
    await rename(file, `${file}.old`); await writeFile(file, header + user('different occupant'))
    await assert.rejects(readPiLiveTail(identity, initial.cursor, signal()), /history changed/)
  })
})

test('Pi Live rechecks displayed recent records beyond the old 4 KiB checkpoint', () => fixture(async (file, identity) => {
  const filler = user('x'.repeat(8192))
  await appendFile(file, user('original') + filler)
  const first = await readPiLiveTail(identity, null, signal())
  await writeFile(file, header + user('replaced') + filler + user('new append'))
  await assert.rejects(readPiLiveTail(identity, first.cursor, signal()), /history changed/)
}))

test('a changed routing revision at the batch commit boundary discards the lease', () => fixture(async (file, identity) => {
  const sessions = new PiLiveSessions(), id = 'd'.repeat(32)
  let verifies = 0, current = true
  await sessions.start('owner', id, signal(), async () => ({ initial: identity, async resolve() { if (++verifies === 3) current = false; return identity }, assertCurrent() { if (!current) throw new Error('Routing changed') } }))
  await appendFile(file, user('must not appear'))
  await assert.rejects(sessions.read('owner', id, signal()), /Live Pi stopped/)
  assert.equal(verifies, 3)
  assert.deepEqual(sessions.stop('owner', id), { stopped: false })
}))

test('Pi Live leases are caller-bound, expiring, and reverified before publishing a changed batch', () => fixture(async (file, identity) => {
  let now = 0, verifies = 0, invalidateAt = Infinity
  const sessions = new PiLiveSessions(() => now), id = 'a'.repeat(32)
  const authorize = async () => ({ initial: identity, async resolve() { if (++verifies >= invalidateAt) throw new Error('Private path or SQLite error'); return identity } })
  await sessions.start('owner', id, signal(), authorize)
  assert.equal(verifies, 1)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(sessions.start('owner', 'b'.repeat(32), cancelled.signal, authorize), /Live Pi stopped/)
  assert.deepEqual(sessions.stop('other', id), { stopped: false }); await assert.rejects(sessions.read('other', id, signal()), /Live Pi stopped/)
  await appendFile(file, user('published'))
  assert.deepEqual((await sessions.read('owner', id, signal())).events.map(e => e.text), ['published']); assert.equal(verifies, 3)
  await appendFile(file, user('not published'))
  invalidateAt = 5
  await assert.rejects(sessions.read('owner', id, signal()), /^Error: Live Pi stopped/)
  assert.deepEqual(sessions.stop('owner', id), { stopped: false })
  invalidateAt = Infinity
  await sessions.start('owner', id, signal(), authorize); now += 45_001
  await assert.rejects(sessions.read('owner', id, signal()), /Live Pi stopped/)
}))

test('Pi Live discards staged rows when the verified history rotates mid-read', () => fixture(async (file, identity) => {
  const sessions = new PiLiveSessions(), id = 'c'.repeat(32), replacement = `${file}.next.jsonl`
  await writeFile(replacement, header + user('new history'))
  const { dev, ino } = await stat(replacement), next = { file: replacement, dev: String(dev), ino: String(ino) }
  let calls = 0
  await sessions.start('owner', id, signal(), async () => ({ initial: identity, async resolve() { return ++calls < 3 ? identity : next } }))
  await appendFile(file, user('staged from old history'))
  const pending = await sessions.read('owner', id, signal())
  assert.equal(pending.waiting, true); assert.deepEqual(pending.events, [])
  assert.deepEqual((await sessions.read('owner', id, signal())).events.map(event => event.text), ['new history'])
}))

test('Pi Live idle expiry cannot interrupt an admitted read on another panel', () => fixture(async (file, identity) => {
  let now = 0, resume: () => void = () => {}
  const gate = new Promise<void>(resolve => { resume = resolve }), sessions = new PiLiveSessions(() => now)
  const authorize = async () => ({ initial: identity, resolve: async () => identity })
  const id = 'a'.repeat(32), other = 'b'.repeat(32)
  await sessions.start('owner', id, signal(), async () => ({ initial: identity, resolve: async () => { if (now) await gate; return identity } }))
  await appendFile(file, user('admitted'))
  now = 44_999
  const pending = sessions.read('owner', id, signal())
  now = 45_001
  try { await sessions.start('other', other, signal(), authorize) } finally { resume() }
  assert.deepEqual((await pending).events.map(event => event.text), ['admitted'])
}))

test('Pi Live rejection after target loss does not open a retry view for the old seat', async () => {
  let eligible = true, reject: (error: Error) => void = () => {}
  const shown: string[] = [], scope: PiLiveScope = { source: 'tui', instanceKey: 'a'.repeat(64), podKey: 'pod', seatKey: 'seat', session: 'seat@pod' }
  const pending = new Promise<never>((_resolve, fail) => { reject = fail })
  const controller = createPiLiveController(async name => name === 'pi-live.stop' ? { stopped: true } : pending,
    { reset: label => shown.push(label), append: () => {}, status: text => shown.push(text), hide: () => shown.push('hidden') }, () => eligible, () => true, () => 'b'.repeat(32))
  assert.equal(controller.open(scope, 'old target'), true)
  eligible = false; reject(new Error('Late rejection'))
  await new Promise(resolve => setImmediate(resolve)); assert.equal(shown.at(-1), 'hidden'); assert.equal(controller.resume(), false)
})

test('Pi Live panel clears the previous history when waiting or rebinding without another start', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const id = 'c'.repeat(32), scope: PiLiveScope = { source: 'tui', instanceKey: 'e'.repeat(64), podKey: 'pod', seatKey: 'seat', session: 'seat@pod' }
  const base: PiLiveBatch = { id, events: [], more: false, omittedHistory: false, skippedRecords: 0 }
  const event = (text: string): PiLiveBatch['events'] => [{ key: 'same-offset', kind: 'user', title: 'You', text }]
  const batches = [{ ...base, events: event('old') }, { ...base, waiting: true }, { ...base, waiting: true }, { ...base, events: event('resumed') }, { ...base, reset: true, events: event('replacement') }]
  const requests: string[] = [], resets: string[] = [], rows: string[] = [], statuses: string[] = []
  const controller = createPiLiveController(async name => { requests.push(name); return batches.shift() },
    { reset: label => { resets.push(label); rows.length = 0 }, append: batch => rows.push(...batch.events.map(e => e.text)), status: text => statuses.push(text), hide: () => {} }, () => true, () => true, () => id)
  const settled = () => new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.open(scope, 'target'), true); await settled(); assert.deepEqual(rows, ['old'])
  t.mock.timers.tick(2000); await settled(); assert.deepEqual(rows, []); assert.match(statuses.at(-1)!, /Waiting/)
  t.mock.timers.tick(5000); await settled(); assert.equal(resets.length, 2)
  t.mock.timers.tick(5000); await settled(); assert.deepEqual(rows, ['resumed'])
  t.mock.timers.tick(2000); await settled(); assert.deepEqual(rows, ['replacement']); assert.equal(resets.length, 3)
  assert.equal(requests.filter(name => name === 'pi-live.start').length, 1)
  controller.close()
})

test('Pi Live panel opts in explicitly and discards late results when hidden or retargeted', async () => {
  const allowed: PiLiveScope = { source: 'tui', instanceKey: 'e'.repeat(64), podKey: 'pod', seatKey: 'seat', session: 'seat@pod' }
  const id = 'b'.repeat(32), calls: string[] = [], shown: string[] = [], appended: PiLiveBatch[] = []
  const pending: { resolve: (value: unknown) => void; signal?: AbortSignal }[] = []
  let visible = false, eligible = true
  const controller = createPiLiveController(async (name, _input, options) => {
    calls.push(name)
    if (name === 'pi-live.stop') return { stopped: true }
    return new Promise(resolve => pending.push({ resolve, signal: options?.signal }))
  }, { reset: label => shown.push(`reset ${label}`), append: batch => appended.push(batch), status: message => shown.push(message), hide: () => shown.push('hidden') }, () => eligible, () => visible, () => id)
  controller.sync(); assert.equal(controller.open(allowed, 'label'), false); assert.deepEqual(calls, [])
  visible = true; assert.equal(controller.open(allowed, 'label'), true)
  visible = false; controller.sync(); assert.ok(pending[0].signal?.aborted); assert.match(shown.at(-1)!, /Paused/)
  pending[0].resolve({ id, events: [{ key: 'late', kind: 'user', title: 'You', text: 'do not show' }] })
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(appended, [])
  visible = true; assert.equal(controller.resume(), true)
  eligible = false; controller.sync(); assert.equal(shown.at(-1), 'hidden'); assert.ok(pending[1].signal?.aborted)
  pending[1].resolve({ id, events: [{ key: 'late again', kind: 'user', title: 'You', text: 'do not show' }] })
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(appended, [])
  assert.deepEqual(calls, ['pi-live.start', 'pi-live.stop', 'pi-live.start', 'pi-live.stop'])
})
