import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, lstat } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { GITLEAKS } from './settings.mjs'
const exec = promisify(execFile)

export async function installGitleaks(directory, { execute = exec, fetcher = fetch, env, platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') throw new Error('Pinned secret-scanner bootstrap requires macOS ARM64')
  const archive = path.join(directory, 'gitleaks.tar.gz')
  const response = await fetcher(GITLEAKS.url, { signal: AbortSignal.timeout(60000) })
  if (!response.ok || !response.body) throw new Error('Pinned secret scanner download failed')
  let size = 0
  const hash = createHash('sha256')
  const tap = new Transform({ transform(chunk, encoding, done) {
    size += chunk.length
    if (size > 32 * 1024 * 1024) { done(new Error('Secret scanner archive exceeds the download limit')); return }
    hash.update(chunk); done(null, chunk)
  } })
  await pipeline(Readable.fromWeb(response.body), tap, createWriteStream(archive, { flags: 'wx', mode: 0o600 }))
  if (hash.digest('hex') !== GITLEAKS.sha256) throw new Error('Secret scanner checksum mismatch')
  await execute('/usr/bin/tar', ['-xzf', archive, '-C', directory, 'gitleaks'], { env, timeout: 30000 })
  const binary = path.join(directory, 'gitleaks')
  if (!(await lstat(binary)).isFile()) throw new Error('Secret scanner artifact is not a regular executable')
  await chmod(binary, 0o700)
  const version = await execute(binary, ['version'], { env, timeout: 10000 })
  if (version.stdout.trim() !== GITLEAKS.version) throw new Error('Secret scanner version mismatch')
  return binary
}
