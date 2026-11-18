import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stageIntelDmg } from '../ci/intel/dmg-cache.mjs'

const contents = 'fixture bytes for a pinned public DMG'
const digest = text => createHash('sha256').update(text).digest('hex')
const sha256 = digest(contents)
const key = `orca-x64-${sha256}.dmg`
const olderKey = `orca-x64-${digest('older pin')}.dmg`
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'openrig-dmg-cache-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cacheDirectory = path.join(root, 'runner-cache'), first = path.join(root, 'first.dmg'), second = path.join(root, 'second.dmg')
  const download = async (target, body = contents) => {
    await writeFile(target, body, { flag: 'wx' })
    return { bytes: Buffer.byteLength(body), sha256: digest(body), attempts: 1 }
  }
  return { root, cacheDirectory, first, second, download }
}

test('an Intel cache miss stores one verified DMG and the next run uses a private copy without downloading', async t => {
  const f = await fixture(t)
  const first = await stageIntelDmg(f.first, { ...f, sha256, download: () => f.download(f.first) })
  assert.equal(first.cache, 'miss')
  assert.deepEqual(await readdir(f.cacheDirectory), [key])
  const second = await stageIntelDmg(f.second, { ...f, sha256, download: async () => assert.fail('cache hit must not download') })
  assert.deepEqual(second, { bytes: Buffer.byteLength(contents), sha256, attempts: 0, cache: 'hit' })
  await writeFile(path.join(f.cacheDirectory, key), 'different cache bytes')
  assert.equal(await readFile(f.second, 'utf8'), contents)
})

test('wrong cached bytes are replaced; pruning touches only old Intel keys and stale partial files', async t => {
  const f = await fixture(t), notices = []
  const stale = '.openrig-intel-dmg-00000000-0000-0000-0000-000000000001.part'
  const fresh = '.openrig-intel-dmg-00000000-0000-0000-0000-000000000002.part'
  await mkdir(f.cacheDirectory)
  for (const name of [key, olderKey, 'keep.txt', stale, fresh]) await writeFile(path.join(f.cacheDirectory, name), 'old bytes')
  await mkdir(path.join(f.cacheDirectory, `orca-x64-${digest('fixture directory')}.dmg`))
  await utimes(path.join(f.cacheDirectory, stale), new Date(0), new Date(0))
  const result = await stageIntelDmg(f.first, { ...f, sha256, onCache: note => notices.push(note), download: () => f.download(f.first) })
  assert.equal(result.cache, 'invalid')
  assert.match(notices[0], /invalid/)
  assert.equal(await readFile(path.join(f.cacheDirectory, key), 'utf8'), contents)
  for (const name of [olderKey, stale]) await assert.rejects(lstat(path.join(f.cacheDirectory, name)), { code: 'ENOENT' })
  for (const name of ['keep.txt', fresh]) assert.equal(await readFile(path.join(f.cacheDirectory, name), 'utf8'), 'old bytes')
  assert.equal((await lstat(path.join(f.cacheDirectory, `orca-x64-${digest('fixture directory')}.dmg`))).isDirectory(), true)
})

test('the Intel cache never follows a symlink entry and never publishes mismatched download bytes', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside')
  await mkdir(f.cacheDirectory); await writeFile(outside, contents); await symlink(outside, path.join(f.cacheDirectory, key))
  const result = await stageIntelDmg(f.first, { ...f, sha256, download: () => f.download(f.first, 'bad fresh download') })
  assert.equal(result.cache, 'invalid')
  assert.notEqual(result.sha256, sha256)
  assert.equal((await lstat(path.join(f.cacheDirectory, key))).isSymbolicLink(), true)
  assert.equal(await readFile(outside, 'utf8'), contents)
  const repaired = await stageIntelDmg(f.second, { ...f, sha256, download: () => f.download(f.second) })
  assert.equal(repaired.cache, 'invalid')
  assert.equal((await lstat(path.join(f.cacheDirectory, key))).isFile(), true)
  assert.equal(await readFile(outside, 'utf8'), contents)
})

test('an unsafe cache directory does not prevent downloading the pinned asset', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'other-dir')
  await mkdir(outside); await symlink(outside, f.cacheDirectory)
  const result = await stageIntelDmg(f.first, { ...f, sha256, download: () => f.download(f.first) })
  assert.equal(result.cache, 'unavailable')
  assert.deepEqual(await readdir(outside), [])
  assert.equal(await readFile(f.first, 'utf8'), contents)
})
