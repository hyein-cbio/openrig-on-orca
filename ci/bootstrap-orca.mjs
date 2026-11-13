#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { ORCA } from './settings.mjs'
const exec = promisify(execFile)

export function verifyArtifact(actual) {
  if (actual !== ORCA.sha256) throw new Error('Orca DMG checksum mismatch; refusing to mount or run it')
}
export function verifySignature(text) {
  if (!text.split(/\r?\n/).includes(`TeamIdentifier=${ORCA.teamId}`) || !text.split(/\r?\n/).includes(`Identifier=${ORCA.bundleId}`)) throw new Error('Orca code-signing identity does not match the pinned publisher')
}
export async function installOrca(destination, { execute = exec, fetcher = fetch, platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') throw new Error('Pinned CircleCI bootstrap requires macOS ARM64')
  await mkdir(destination, { recursive: true })
  if ((await readdir(destination)).length) throw new Error('Orca bootstrap destination must be empty')
  const dmg = path.join(destination, 'orca.dmg'), mount = path.join(destination, 'mount')
  const response = await fetcher(ORCA.url, { signal: AbortSignal.timeout(180000) })
  if (!response.ok || !response.body) throw new Error('Official pinned Orca download failed')
  const hash = createHash('sha256')
  const tap = new Transform({ transform(chunk, encoding, done) { hash.update(chunk); done(null, chunk) } })
  await pipeline(Readable.fromWeb(response.body), tap, createWriteStream(dmg, { flags: 'wx' }))
  verifyArtifact(hash.digest('hex'))
  await mkdir(mount)
  let mounted = false
  try {
    await execute('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { timeout: 60000 })
    mounted = true
    const app = path.join(destination, 'Orca.app')
    await execute('ditto', [path.join(mount, 'Orca.app'), app], { timeout: 90000 })
    await execute('codesign', ['--verify', '--deep', '--strict', app], { timeout: 60000 })
    const signature = await execute('codesign', ['-dv', '--verbose=4', app])
    verifySignature(signature.stderr)
    const cli = path.join(app, 'Contents', 'Resources', 'bin', 'orca')
    const version = await execute(cli, ['--version'])
    if (version.stdout.trim() !== ORCA.version) throw new Error('Installed Orca version differs from the pinned release')
    return { cli, version: ORCA.version, sha256: ORCA.sha256, teamId: ORCA.teamId }
  } finally {
    if (mounted) await execute('hdiutil', ['detach', mount], { timeout: 30000 })
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2] ? path.resolve(process.argv[2]) : await mkdtemp(path.join(tmpdir(), 'openrig-orca-app-'))
  console.log(JSON.stringify(await installOrca(destination), null, 2))
}
