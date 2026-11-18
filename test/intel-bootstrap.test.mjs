import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { downloadIntelArtifact, installIntelOrca } from '../ci/intel/bootstrap-orca.mjs'
import { ORCA_INTEL } from '../ci/intel/settings.mjs'

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'intel-bootstrap-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, dmg: path.join(directory, 'orca.dmg') }
}

test('a stalled Intel DMG body times out, removes its partial bytes and retries from byte zero', async t => {
  const { dmg } = await fixture(t), notices = [], waits = [], complete = 'complete fixture DMG'
  let attempts = 0
  const result = await downloadIntelArtifact(dmg, {
    timeoutMs: 250, wait: async ms => { waits.push(ms); await assert.rejects(lstat(dmg), { code: 'ENOENT' }) },
    onRetry: message => notices.push(message),
    fetcher: async (url, { signal }) => {
      assert.equal(url, ORCA_INTEL.url)
      assert.equal(signal.aborted, false)
      if (++attempts > 1) return new Response(complete)
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')) } }))
    }
  })
  assert.equal(attempts, 2)
  assert.deepEqual(waits, [2000])
  assert.match(notices[0], /attempt 1\/2: timed out .*received 7 bytes/)
  assert.deepEqual(result, { sha256: createHash('sha256').update(complete).digest('hex'), bytes: Buffer.byteLength(complete), attempts: 2 })
  assert.equal(await readFile(dmg, 'utf8'), complete)
})

test('Intel download retries a transient server failure once and stops on a second failure', async t => {
  const { dmg } = await fixture(t), notices = []
  let attempts = 0
  await assert.rejects(downloadIntelArtifact(dmg, {
    wait: async () => {}, onRetry: message => notices.push(message),
    fetcher: async () => { attempts++; return new Response('upstream unusable', { status: 503 }) }
  }), /attempt 2\/2: HTTP 503; received 0 bytes/)
  assert.equal(attempts, 2)
  assert.equal(notices.length, 1)
  await assert.rejects(lstat(dmg), { code: 'ENOENT' })
})

test('Intel network error diagnostics omit transport details that could contain signed URLs', async t => {
  const { dmg } = await fixture(t), notices = []
  let attempts = 0
  const result = await downloadIntelArtifact(dmg, {
    wait: async () => {}, onRetry: message => notices.push(message),
    fetcher: async () => {
      if (++attempts === 1) throw new TypeError('redacted transport detail', { cause: Object.assign(new Error('private redirect'), { code: 'ECONNRESET' }) })
      return new Response('successful fixture')
    }
  })
  assert.equal(result.attempts, 2)
  assert.deepEqual(notices, ['Intel Orca DMG download attempt 1/2: transfer lost (ECONNRESET); received 0 bytes'])
})

test('Intel download does not retry a missing asset, local write refusal or checksum mismatch', async t => {
  const { directory, dmg } = await fixture(t)
  const wait = async () => assert.fail('unexpected retry')
  await assert.rejects(downloadIntelArtifact(dmg, { wait, fetcher: async () => new Response('missing', { status: 404 }) }), /attempt 1\/2: HTTP 404/)
  await writeFile(dmg, 'preexisting fixture')
  await assert.rejects(downloadIntelArtifact(dmg, { wait, fetcher: async () => new Response('must not overwrite') }), /attempt 1\/2: download or local write failed/)
  assert.equal(await readFile(dmg, 'utf8'), 'preexisting fixture')
  await rm(dmg)
  let attempts = 0
  await assert.rejects(installIntelOrca(directory, {
    platform: 'darwin', arch: 'x64', fetcher: async () => { attempts++; return new Response('bad DMG') },
    execute: async () => assert.fail('unverified DMG reached a macOS install command')
  }), /checksum mismatch/)
  assert.equal(attempts, 1)
})
