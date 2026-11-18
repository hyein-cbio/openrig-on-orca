import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const dmgKey = /^orca-x64-[a-f0-9]{64}\.dmg$/
const partialKey = /^\.openrig-intel-dmg-[a-f0-9-]{36}\.part$/
const MAX_CACHED_BYTES = 512 * 1024 * 1024
const PARTIAL_AGE_MS = 48 * 60 * 60 * 1000
const owned = info => process.getuid?.() === info.uid

async function privateDirectory(directory) {
  if (!path.isAbsolute(directory) || path.resolve(directory) === path.parse(directory).root) throw new Error('Invalid cache directory')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || !owned(info) || (info.mode & 0o022)) throw new Error('Cache directory is not owned by this runner account')
  return realpath(directory)
}

async function stageCachedDmg(cacheFile, target, sha256) {
  // Never mount a shared path: copy and hash the exact bytes staged for this job.
  const input = await open(cacheFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const candidate = `${target}.${randomUUID()}.cache`
  let created = false
  try {
    const info = await input.stat()
    if (!info.isFile() || !owned(info) || !info.size || info.size > MAX_CACHED_BYTES) return null
    const output = await open(candidate, 'wx', 0o600)
    created = true
    const hash = createHash('sha256')
    let bytes = 0
    const tap = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length
      if (bytes > MAX_CACHED_BYTES) { done(new Error('Cached DMG exceeded its size limit')); return }
      hash.update(chunk); done(null, chunk)
    } })
    try { await pipeline(input.createReadStream(), tap, output.createWriteStream()) }
    finally { await output.close() }
    if (hash.digest('hex') !== sha256) return null
    await rename(candidate, target)
    created = false
    return { sha256, bytes, attempts: 0, cache: 'hit' }
  } finally {
    try { await input.close() } finally { if (created) await rm(candidate, { force: true }) }
  }
}

async function saveCachedDmg(target, cacheFile) {
  const partial = path.join(path.dirname(cacheFile), `.openrig-intel-dmg-${randomUUID()}.part`)
  await copyFile(target, partial, constants.COPYFILE_EXCL)
  try {
    // Atomic on this filesystem; another job can only see a complete cache entry.
    await rename(partial, cacheFile)
  } finally { await rm(partial, { force: true }) }
}

async function pruneCache(directory, keep) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === keep || !(dmgKey.test(entry.name) || partialKey.test(entry.name))) continue
    const file = path.join(directory, entry.name)
    try {
      const info = await lstat(file)
      if (!info.isFile() || !owned(info)) continue
      if (partialKey.test(entry.name) && Date.now() - info.mtimeMs < PARTIAL_AGE_MS) continue
      await rm(file)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

/** Optional per-runner cache of public DMG bytes; availability is not a CI prerequisite. */
export async function stageIntelDmg(target, { cacheDirectory, sha256, download, onCache = () => {} }) {
  if (!cacheDirectory) return { ...await download(), cache: 'disabled' }
  let directory
  try { directory = await privateDirectory(cacheDirectory) }
  catch {
    onCache('unavailable; using the pinned download')
    return { ...await download(), cache: 'unavailable' }
  }
  const key = `orca-x64-${sha256}.dmg`
  if (!dmgKey.test(key)) throw new Error('Invalid Intel Orca cache digest')
  const cacheFile = path.join(directory, key)
  const prune = async () => {
    try { await pruneCache(directory, key) } catch { onCache('prune failed; continuing with the verified DMG') }
  }
  let status = 'miss', cached
  try {
    cached = await stageCachedDmg(cacheFile, target, sha256)
    if (!cached) status = 'invalid'
  } catch (error) { if (error.code !== 'ENOENT') status = 'invalid' }
  if (cached) {
    onCache('hit; SHA-256 verified on the staged copy')
    await prune()
    return cached
  }
  onCache(`${status}; using the pinned download`)
  const transfer = await download()
  if (transfer.sha256 === sha256 && transfer.bytes <= MAX_CACHED_BYTES) {
    try { await saveCachedDmg(target, cacheFile); await prune() }
    catch { onCache('write failed; using the verified download for this job only') }
  }
  return { ...transfer, cache: status }
}
