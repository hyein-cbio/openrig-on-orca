#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertLiveReport, cleanCiEnvironment, optionValue } from '../scripts/ci-support.mjs'
import { findExecutable } from '../src/runtime.mjs'
import { installOrca } from './bootstrap-orca.mjs'
import { NODES, ORCA } from './settings.mjs'
const exec = promisify(execFile)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export function validateCell(suite, version) {
  if (suite === 'core' && [NODES.core22, NODES.core24].includes(version)) return
  if (suite === 'orca' && version === NODES.live) return
  throw new Error(`Unsupported CI cell: ${suite}/${version}`)
}
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
export function junitForSteps(steps) {
  return `<testsuite name="macos-ci" tests="${steps.length}" failures="${steps.filter(s => !s.ok).length}">${steps.map(s => `<testcase classname="${xml(s.suite)}" name="${xml(s.name)}" time="${s.seconds}">${s.ok ? '' : '<failure message="Step failed; see allowlisted CI step log"/>'}</testcase>`).join('')}</testsuite>\n`
}
export function recordRunnerFailure(summary, error, name = 'runner-validation') {
  summary.error ||= error instanceof Error ? error.message : String(error)
  summary.exitCode = 1
  if (name !== 'runner-validation' || !summary.steps.some(step => !step.ok)) summary.steps.push({ suite: summary.suite, name, seconds: 0, ok: false })
}

export async function cleanupRunnerDownload(directory, summary, remove = rm) {
  if (!directory) return
  const started = Date.now()
  try {
    await remove(directory, { recursive: true, force: true })
    summary.steps.push({ suite: summary.suite, name: 'bootstrap-cleanup', seconds: (Date.now() - started) / 1000, ok: true })
    summary.bootstrapCleanup = 'complete'
  } catch (error) { recordRunnerFailure(summary, error, 'bootstrap-cleanup') }
}

export async function runCi(argv) {
  const suite = optionValue(argv, '--suite'), version = optionValue(argv, '--node-version')
  const artifacts = path.resolve(optionValue(argv, '--output') || `ci-results/${suite || 'invalid'}`)
  const reports = path.join(root, 'test-reports')
  const env = cleanCiEnvironment(process.env)
  let downloadDirectory
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
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('CircleCI worker requires a managed macOS ARM64 VM')
    if (process.getuid?.() === 0) throw new Error('Run the CI worker as an unprivileged user')
    if (process.version !== `v${version}`) throw new Error('Node does not match the exact CI cell version')
    summary.source = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root, env })).stdout.trim()
    await step('source-secrets', process.execPath, ['scripts/scan-secrets.mjs'])
    if (suite === 'orca') {
      summary.tmux = JSON.parse(await step('tmux-preflight', process.execPath, ['ci/ensure-tmux.mjs']))
      env.PATH = [env.PATH, path.dirname(summary.tmux.path)].filter(Boolean).join(path.delimiter)
    }
    const op = await findExecutable('op', env)
    await step('dependencies', op || 'npm', op ? ['plugin', 'run', '--', 'npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'] : ['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
    const tests = (await readdir(path.join(root, 'test'))).filter(p => p.endsWith('.test.mjs')).sort().map(p => `test/${p}`)
    await step('core-tests', process.execPath, ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=./ci/junit-reporter.mjs', `--test-reporter-destination=${path.join(reports, `${suite}-core.xml`)}`, ...tests])
    if (suite === 'orca') {
      const provided = optionValue(argv, '--orca-cli')
      if (provided) env.ORCA_CLI_COMMAND = path.resolve(provided)
      else {
        downloadDirectory = await mkdtemp(path.join(tmpdir(), 'openrig-orca-ci-app-'))
        const installed = await installOrca(downloadDirectory, { execute: (file, args, options = {}) => exec(file, args, { env, ...options }) })
        env.ORCA_CLI_COMMAND = installed.cli
        summary.bootstrap = { version: installed.version, sha256: installed.sha256, teamId: installed.teamId }
      }
      const cli = env.ORCA_CLI_COMMAND
      const actual = (await step('orca-version', cli, ['--version'])).trim()
      if (actual !== ORCA.version) throw new Error('Orca CLI version differs from compatibility pin')
      await step('orca-types', cli, ['plugin', 'types', root, '--json'])
      await step('typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', '.'])
      await step('plugin-tests', cli, ['plugin', 'test', root, '--json'])
      const checked = JSON.parse(await step('plugin-check', cli, ['plugin', 'check', root, '--json']))
      if (!checked.ok || !checked.result.panels.every(p => !p.issues.length && !p.warnings.length)) throw new Error('Plugin panel check is incomplete or contains warnings')
      const staged = JSON.parse(await step('stage', process.execPath, ['scripts/stage.mjs']))
      await step('inspect', cli, ['plugin', 'inspect', staged.path, '--json'])
      const output = path.join(artifacts, 'live')
      await step('sandbox', process.execPath, ['scripts/sandbox.mjs', '--install', '--approve-plugin', '--output', output])
      const report = JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'))
      assertLiveReport(report, { install: true })
      summary.live = { checks: report.checks.map(c => c.id), visual: report.visual }
    }
    await step('tracked-clean', 'git', ['diff', '--exit-code', 'HEAD'])
    summary.exitCode = 0
  } catch (error) { recordRunnerFailure(summary, error) }
  finally {
    await cleanupRunnerDownload(downloadDirectory, summary)
    await writeFile(path.join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
    await writeFile(path.join(reports, `${suite || 'invalid'}-steps.xml`), junitForSteps(summary.steps))
  }
  console.log(JSON.stringify(summary, null, 2))
  return summary.exitCode
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCi(process.argv.slice(2))
