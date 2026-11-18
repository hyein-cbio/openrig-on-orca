#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { cleanCiEnvironment, optionValue } from '../../scripts/ci-support.mjs'
import { assertIntelReport } from '../../scripts/intel/support.mjs'
import { validateCell, junitForSteps, recordRunnerFailure, cleanupRunnerDownload } from '../run-ci.mjs'
import { findExecutable } from '../../src/runtime.mjs'
import { installIntelOrca } from './bootstrap-orca.mjs'
import { ORCA_INTEL as ORCA, requireIntelMac } from './settings.mjs'
const exec = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export async function cleanupIntelStaging(directory, summary, remove = rm) {
  if (!directory) return
  const started = Date.now()
  try {
    await remove(directory, { recursive: true, force: true })
    summary.steps.push({ suite: summary.suite, name: 'staging-cleanup', seconds: (Date.now() - started) / 1000, ok: true })
    summary.stagingCleanup = 'complete'
  } catch (error) { recordRunnerFailure(summary, error, 'staging-cleanup') }
}

export async function sandboxCleanupVerified(output) {
  try {
    const report = JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'))
    return report.cleanup?.completed === true && Array.isArray(report.warnings) && report.warnings.length === 0
  } catch { return false }
}

export async function runIntelCi(argv) {
  const suite = optionValue(argv, '--suite'), version = optionValue(argv, '--node-version')
  const artifacts = path.resolve(optionValue(argv, '--output') || `ci-results/intel-${suite || 'invalid'}`)
  const reports = path.join(root, 'test-reports')
  const env = cleanCiEnvironment(process.env)
  let downloadDirectory, stagingDirectory, sandboxStarted = false
  const summary = { suite, node: version, actualNode: process.version, platform: process.platform, arch: process.arch, steps: [], exitCode: 1 }
  await mkdir(artifacts, { recursive: true }); await mkdir(reports, { recursive: true })
  async function step(name, file, args, options = {}) {
    console.log(`CI: ${name}`)
    const started = Date.now()
    let result, ok = true
    try { result = await exec(file, args, { cwd: root, env, timeout: 600000, maxBuffer: 16 * 1024 * 1024, ...options }) }
    catch (error) { result = error; ok = false }
    await writeFile(path.join(artifacts, `${name}.log`), String(result.stdout || '') + String(result.stderr || ''))
    summary.steps.push({ suite, name, seconds: (Date.now() - started) / 1000, ok })
    if (!ok) throw new Error(`${name} failed; see ${name}.log`)
    return result.stdout
  }
  try {
    validateCell(suite, version)
    requireIntelMac()
    if (process.getuid?.() === 0) throw new Error('Run the CI worker as an unprivileged user')
    if (process.version !== `v${version}`) throw new Error('Node does not match the exact CI cell version')
    summary.source = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root, env })).stdout.trim()
    await step('source-secrets', process.execPath, ['scripts/scan-secrets.mjs'])
    if (suite === 'orca') {
      summary.tmux = JSON.parse(await step('tmux-preflight', process.execPath, ['ci/intel/ensure-tmux.mjs']))
      env.PATH = [env.PATH, path.dirname(summary.tmux.path)].filter(Boolean).join(path.delimiter)
    }
    const op = await findExecutable('op', env)
    await step('dependencies', op || 'npm', op ? ['plugin', 'run', '--', 'npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'] : ['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
    const tests = (await readdir(path.join(root, 'test'))).filter(p => p.endsWith('.test.mjs')).sort().map(p => `test/${p}`)
    await step('core-tests', process.execPath, ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=./ci/junit-reporter.mjs', `--test-reporter-destination=${path.join(reports, `intel-${suite}-core.xml`)}`, ...tests])
    if (suite === 'orca') {
      const provided = optionValue(argv, '--orca-cli')
      if (provided) env.ORCA_CLI_COMMAND = path.resolve(provided)
      else {
        console.log('CI: bootstrap-orca')
        const started = Date.now(), log = []
        let ok = false
        try {
          downloadDirectory = await mkdtemp(path.join(tmpdir(), 'openrig-orca-ci-app-'))
          const installed = await installIntelOrca(downloadDirectory, {
            execute: (file, args, options = {}) => exec(file, args, { env, ...options }),
            cacheDirectory: process.env.OPENRIG_INTEL_DMG_CACHE,
            onCache: message => { log.push(`Intel Orca DMG cache: ${message}`); console.log(`CI: Intel Orca DMG cache ${message}`) },
            onRetry: message => { log.push(message); console.log(`CI: ${message}; retrying once`) }
          })
          env.ORCA_CLI_COMMAND = installed.cli
          summary.bootstrap = { version: installed.version, sha256: installed.sha256, teamId: installed.teamId, arch: installed.arch, transfer: installed.transfer }
          log.push(`Verified pinned Intel Orca ${installed.version}; ${installed.transfer.bytes} bytes, ${installed.transfer.attempts} attempt(s)`)
          ok = true
        } catch (error) { log.push(error.message); throw error }
        finally {
          summary.steps.push({ suite, name: 'bootstrap-orca', seconds: (Date.now() - started) / 1000, ok })
          await writeFile(path.join(artifacts, 'bootstrap-orca.log'), log.join('\n') + '\n')
        }
      }
      const cli = env.ORCA_CLI_COMMAND
      const actual = (await step('orca-version', cli, ['--version'])).trim()
      if (actual !== ORCA.version) throw new Error('Orca CLI version differs from compatibility pin')
      await step('orca-types', cli, ['plugin', 'types', root, '--json'])
      await step('typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', '.'])
      await step('plugin-tests', cli, ['plugin', 'test', root, '--json'])
      const checked = JSON.parse(await step('plugin-check', cli, ['plugin', 'check', root, '--json']))
      if (!checked.ok || !checked.result.panels.every(p => !p.issues.length && !p.warnings.length)) throw new Error('Plugin panel check is incomplete or contains warnings')
      stagingDirectory = await mkdtemp(path.join(tmpdir(), 'openrig-intel-plugin-'))
      await step('stage', process.execPath, ['scripts/stage-intel.mjs', stagingDirectory])
      await step('inspect', cli, ['plugin', 'inspect', stagingDirectory, '--json'])
      const output = path.join(artifacts, 'live')
      await rm(path.join(output, 'report.json'), { force: true }) // Never accept a previous run's cleanup receipt.
      sandboxStarted = true
      await step('sandbox', process.execPath, ['scripts/intel/sandbox.mjs', '--install', '--approve-plugin', '--output', output])
      const report = JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'))
      assertIntelReport(report, { install: true })
      summary.live = { checks: report.checks.map(c => c.id), visual: report.visual }
    }
    await step('tracked-clean', 'git', ['diff', '--exit-code', 'HEAD'])
    summary.exitCode = 0
  } catch (error) { recordRunnerFailure(summary, error) }
  finally {
    await cleanupIntelStaging(stagingDirectory, summary)
    // A killed/uninspectable harness must never race removal of the app it may still own.
    const safeToRemove = !sandboxStarted || await sandboxCleanupVerified(path.join(artifacts, 'live'))
    if (safeToRemove) await cleanupRunnerDownload(downloadDirectory, summary)
    else {
      recordRunnerFailure(summary, new Error('Sandbox cleanup is unverified; owned app download retained for inspection'), 'sandbox-cleanup')
      if (downloadDirectory) {
        summary.bootstrapCleanup = 'retained-unverified-sandbox'
        summary.retainedDownloadDirectory = downloadDirectory
      }
    }
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
    await writeFile(path.join(reports, `intel-${suite || 'invalid'}-steps.xml`), junitForSteps(summary.steps))
  }
  console.log(JSON.stringify(summary, null, 2))
  return summary.exitCode
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runIntelCi(process.argv.slice(2))
