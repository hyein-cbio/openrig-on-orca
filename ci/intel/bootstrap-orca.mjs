#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { verifySignature } from '../bootstrap-orca.mjs'
import { ORCA_INTEL, requireIntelMac } from './settings.mjs'
import { stageIntelDmg } from './dmg-cache.mjs'
const exec = promisify(execFile)

export function verifyIntelArtifact(actual) {
  if (actual !== ORCA_INTEL.sha256) throw new Error('Intel Orca DMG checksum mismatch; refusing to mount or run it')
}
const ATTEMPTS = 2
const ATTEMPT_TIMEOUT_MS = 300_000
const transientNetwork = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'])

// An Intel runner may need more than three minutes to stream the ~289 MB DMG.
// Retry the transfer only; bad integrity, local I/O errors, and install checks fail closed.
export async function downloadIntelArtifact(dmg, { fetcher = fetch, timeoutMs = ATTEMPT_TIMEOUT_MS, wait = delay, onRetry = () => {} } = {}) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let handle, bytes = 0, httpStatus, retryable, detail
    try {
      const response = await fetcher(ORCA_INTEL.url, { signal: controller.signal })
      if (!response.ok) { httpStatus = response.status; throw new Error('HTTP download failure') }
      if (!response.body) throw new Error('The pinned download did not return a body')
      handle = await open(dmg, 'wx')
      const hash = createHash('sha256')
      const tap = new Transform({ transform(chunk, encoding, done) { bytes += chunk.length; hash.update(chunk); done(null, chunk) } })
      await pipeline(Readable.fromWeb(response.body), tap, handle.createWriteStream(), { signal: controller.signal })
      return { sha256: hash.digest('hex'), bytes, attempts: attempt }
    } catch (error) {
      const networkCode = error?.cause?.code ?? error?.code
      if (controller.signal.aborted && error?.name === 'AbortError') { retryable = true; detail = `timed out after ${timeoutMs / 1000}s` }
      else if (httpStatus !== undefined) { retryable = httpStatus === 408 || (httpStatus >= 500 && httpStatus <= 599); detail = `HTTP ${httpStatus}` }
      else if (transientNetwork.has(networkCode)) { retryable = true; detail = `transfer lost (${networkCode})` }
      else { retryable = false; detail = 'download or local write failed' }
      if (handle) { await handle.close(); await rm(dmg) }
    } finally {
      clearTimeout(timer)
      controller.abort() // Release any unconsumed response body on failure.
    }
    const message = `Intel Orca DMG download attempt ${attempt}/${ATTEMPTS}: ${detail}; received ${bytes} bytes`
    if (!retryable || attempt === ATTEMPTS) throw new Error(message)
    onRetry(message)
    await wait(2000)
  }
}

export async function installIntelOrca(destination, { execute = exec, fetcher = fetch, onRetry, cacheDirectory, onCache, platform = process.platform, arch = process.arch } = {}) {
  requireIntelMac(platform, arch)
  await mkdir(destination, { recursive: true })
  if ((await readdir(destination)).length) throw new Error('Orca bootstrap destination must be empty')
  const dmg = path.join(destination, 'orca.dmg'), mount = path.join(destination, 'mount')
  const transfer = await stageIntelDmg(dmg, { cacheDirectory, sha256: ORCA_INTEL.sha256, onCache, download: () => downloadIntelArtifact(dmg, { fetcher, onRetry }) })
  verifyIntelArtifact(transfer.sha256)
  await mkdir(mount)
  let mounted = false
  try {
    await execute('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { timeout: 60000 })
    mounted = true
    const app = path.join(destination, 'Orca.app')
    await execute('/usr/bin/ditto', [path.join(mount, 'Orca.app'), app], { timeout: 90000 })
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 60000 })
    verifySignature((await execute('/usr/bin/codesign', ['-dv', '--verbose=4', app])).stderr)
    await execute('/usr/bin/lipo', [path.join(app, 'Contents', 'MacOS', 'Orca'), '-verify_arch', 'x86_64'])
    const cli = path.join(app, 'Contents', 'Resources', 'bin', 'orca')
    if ((await execute(cli, ['--version'])).stdout.trim() !== ORCA_INTEL.version) throw new Error('Installed Orca version differs from the Intel pin')
    return { cli, version: ORCA_INTEL.version, sha256: ORCA_INTEL.sha256, arch: 'x64', teamId: ORCA_INTEL.teamId, transfer: { bytes: transfer.bytes, attempts: transfer.attempts, cache: transfer.cache } }
  } finally {
    if (mounted) await execute('/usr/bin/hdiutil', ['detach', mount], { timeout: 30000 })
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2] ? path.resolve(process.argv[2]) : await mkdtemp(path.join(tmpdir(), 'openrig-intel-app-'))
  console.log(JSON.stringify(await installIntelOrca(destination), null, 2))
}
