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
import { verifySignature } from '../bootstrap-orca.mjs'
import { ORCA_INTEL, requireIntelMac } from './settings.mjs'
const exec = promisify(execFile)

export function verifyIntelArtifact(actual) {
  if (actual !== ORCA_INTEL.sha256) throw new Error('Intel Orca DMG checksum mismatch; refusing to mount or run it')
}
export async function installIntelOrca(destination, { execute = exec, fetcher = fetch, platform = process.platform, arch = process.arch } = {}) {
  requireIntelMac(platform, arch)
  await mkdir(destination, { recursive: true })
  if ((await readdir(destination)).length) throw new Error('Orca bootstrap destination must be empty')
  const dmg = path.join(destination, 'orca.dmg'), mount = path.join(destination, 'mount')
  const response = await fetcher(ORCA_INTEL.url, { signal: AbortSignal.timeout(180000) })
  if (!response.ok || !response.body) throw new Error('Official pinned Intel Orca download failed')
  const hash = createHash('sha256')
  const tap = new Transform({ transform(chunk, encoding, done) { hash.update(chunk); done(null, chunk) } })
  await pipeline(Readable.fromWeb(response.body), tap, createWriteStream(dmg, { flags: 'wx' }))
  verifyIntelArtifact(hash.digest('hex'))
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
    return { cli, version: ORCA_INTEL.version, sha256: ORCA_INTEL.sha256, arch: 'x64', teamId: ORCA_INTEL.teamId }
  } finally {
    if (mounted) await execute('/usr/bin/hdiutil', ['detach', mount], { timeout: 30000 })
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2] ? path.resolve(process.argv[2]) : await mkdtemp(path.join(tmpdir(), 'openrig-intel-app-'))
  console.log(JSON.stringify(await installIntelOrca(destination), null, 2))
}
