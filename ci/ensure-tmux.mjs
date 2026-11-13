#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanCiEnvironment } from '../scripts/ci-support.mjs'
import { findExecutable, run } from '../src/runtime.mjs'

export async function probeTmux(file, env, execute = run) {
  const version = await execute(file, ['-V'], { env })
  if (!version.ok || !/^tmux \d+\.\d+\S*$/.test(version.stdout.trim())) throw new Error('tmux cannot execute or returned an invalid version')
  // A short, private socket avoids macOS's Unix-domain path limit. Never use the default server.
  const directory = await mkdtemp('/tmp/openrig-tmux-check-')
  const socket = path.join(directory, 's')
  let started = false
  try {
    const created = await execute(file, ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'ci-probe', 'exec /bin/sleep 60'], { env })
    started = created.ok
    if (!started) throw new Error('tmux could not create a detached session on its private CI socket')
    const session = await execute(file, ['-S', socket, 'display-message', '-p', '-t', 'ci-probe', '#{session_name}'], { env })
    if (!session.ok || session.stdout.trim() !== 'ci-probe') throw new Error('tmux session verification failed')
  } finally {
    const cleanup = await execute(file, ['-S', socket, 'kill-server'], { env })
    if (started && !cleanup.ok) throw new Error(`tmux probe cleanup failed; private socket retained at ${socket}`)
    await rm(directory, { recursive: true, force: true })
  }
  return version.stdout.trim()
}

export async function ensureTmux({ install = false, baseEnv = process.env, execute = run, find = findExecutable,
  platform = process.platform, arch = process.arch } = {}) {
  const env = cleanCiEnvironment(baseEnv)
  env.PATH = [...new Set([...(env.PATH || '').split(path.delimiter).filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(path.delimiter)
  delete env.TMUX; delete env.TMUX_PANE
  let file = await find('tmux', env)
  if (file) return { path: file, version: await probeTmux(file, env, execute), installAttempted: false, socketProbePassed: true }
  if (!install) throw new Error('A functional tmux installation is mandatory for live CI; run the explicit CI installation step first')
  if (baseEnv.CIRCLECI !== 'true' || platform !== 'darwin' || arch !== 'arm64') throw new Error('Automatic tmux installation is limited to the managed macOS ARM64 CircleCI step')
  const brew = await find('brew', env)
  if (!brew) throw new Error('Homebrew is unavailable on the disposable VM; tmux cannot be installed')
  const installed = await execute(brew, ['install', 'tmux'], {
    env: { ...env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' }, timeout: 600000
  })
  if (!installed.ok && installed.code !== 1) throw new Error('Homebrew did not complete normally; refusing to start live tests')
  file = await find('tmux', env)
  if (!file) throw new Error(`Homebrew exited ${installed.code}; tmux is still missing`)
  const version = await probeTmux(file, env, execute)
  return { path: file, version, installAttempted: true, installExitCode: installed.code,
    recoveredInstallFailure: !installed.ok, socketProbePassed: true }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--install')) throw new Error('Only --install is supported')
    const report = await ensureTmux({ install: process.argv.includes('--install') })
    if (report.recoveredInstallFailure) console.error(`Homebrew exited ${report.installExitCode}, but tmux passed executable, private-session and cleanup checks. Ancillary post-install failures are not treated as tmux failure.`)
    console.log(JSON.stringify(report, null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
