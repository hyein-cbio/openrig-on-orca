#!/usr/bin/env node
// Opt-in Intel driver: the original sandbox remains byte-for-byte unchanged.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { optionValue } from '../ci-support.mjs'
import { requireIntelMac } from '../../ci/intel/settings.mjs'
import { assertIntelReport } from './support.mjs'
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error('Original sandbox contract changed; review the Intel driver before proceeding')
  return text.replace(before, after)
}

export function buildIntelHarness(original, root, argv = []) {
  const cancellationModule = JSON.stringify(pathToFileURL(path.join(root, 'scripts/intel/cancellation.mjs')).href)
  let driver = replaceOnce(original, "import { execFile } from 'node:child_process'", `import { createHarnessCancellation } from ${cancellationModule}`)
  driver = replaceOnce(driver, 'const exec = promisify(execFile)', 'const cancellation = createHarnessCancellation()\nconst execFile = cancellation.execFile\nconst exec = cancellation.execute')
  driver = replaceOnce(driver, 'const args = new Set(process.argv.slice(2))', `const args = new Set(${JSON.stringify(argv)})`)
  driver = replaceOnce(driver, "optionValue(process.argv.slice(2), '--output')", `optionValue(${JSON.stringify(argv)}, '--output')`)
  driver = replaceOnce(driver, "import { stagePlugin } from './stage.mjs'", `import { stageIntelPlugin as stagePlugin } from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/stage-intel.mjs')).href)}`)
  driver = replaceOnce(driver, "import { tmpdir } from 'node:os'", "import { tmpdir, release, cpus } from 'node:os'")
  driver = replaceOnce(driver, 'const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)))', `const source = ${JSON.stringify(root)}`)
  driver = replaceOnce(driver, 'const report = { root, checks:', "const report = { root, host: { platform: process.platform, arch: process.arch, release: release(), cpu: cpus()[0]?.model }, checks:")
  driver = replaceOnce(driver, "  check('runtime-verified',", `  report.versions.openrig = state.snapshot.rigVersion
  report.versions.tmux = state.snapshot.tmuxVersion
  report.runtime = { worker: { platform: state.snapshot.platform, arch: state.snapshot.arch },
    nodeArch: (await invoke(state.snapshot.tools.node, ['-p', 'process.arch'], { env: rigEnv })).stdout.trim(), sqlite: state.snapshot.sqlite.status }
  assert.equal(report.versions.openrig.split(/\\s/, 1)[0], OPENRIG_VERSION)
  assert.equal(report.runtime.nodeArch, 'x64')
  assert.equal(report.runtime.worker.arch, 'x64')
  check('runtime-verified',`)
  driver = replaceOnce(driver, '  while (Date.now() < deadline) {\n    try { return await check() }', '  while (Date.now() < deadline) {\n    cancellation.throwIfCancelled()\n    try { return await check() }')
  driver = replaceOnce(driver, "  const result = await request('setup.execute', { planId: plan.id, workspaceId })", "  if (action === 'start-daemon') daemonStarted = true\n  if (action === 'example-demo') { fixtureStarted = true; rigName = plan.example.rigName }\n  const result = await request('setup.execute', { planId: plan.id, workspaceId })")
  driver = replaceOnce(driver, 'async function invoke(command, argv, options = {}) {', 'async function invoke(command, argv, options = {}) {\n  cancellation.throwIfCancelled()')
  driver = replaceOnce(driver, '} finally {\n  if (!keep) {', '} finally {\n  try {\n    await cancellation.beginCleanup()\n  if (!keep) {')
  driver = replaceOnce(driver, '  if (output) {', '  await cancellation.finishCleanup()\n  report.cleanup = { completed: report.warnings.length === 0 }\n  if (cancellation.signal) report.cancelled = cancellation.signal\n  if (output) {')
  driver = replaceOnce(driver, '  console.log(JSON.stringify(report, null, 2))\n}', '  console.log(JSON.stringify(report, null, 2))\n  } finally {\n    try { await cancellation.finishCleanup() } finally { cancellation.dispose() }\n  }\n}')
  // Resolve the original harness's imports from its original directory, not the temporary driver.
  return driver.replace(/from (['"])(\.{1,2}\/[^'"]+)\1/g, (_, _quote, specifier) =>
    `from ${JSON.stringify(pathToFileURL(path.resolve(root, 'scripts', specifier)).href)}`)
}

export async function runHarnessInProcess(driver) {
  await import(pathToFileURL(driver).href)
}

export async function runIntelSandbox(argv) {
  requireIntelMac()
  const output = optionValue(argv, '--output')
  if (!output || argv.includes('--keep')) throw new Error('Intel verification requires --output and complete cleanup (no --keep)')
  const directory = await mkdtemp(path.join(tmpdir(), 'openrig-intel-driver-'))
  try {
    const driver = path.join(directory, 'sandbox.mjs')
    await writeFile(driver, buildIntelHarness(await readFile(path.join(source, 'scripts/sandbox.mjs'), 'utf8'), source, argv))
    // No detached harness process can outlive this wrapper. SIGTERM unwinds its own finally.
    await runHarnessInProcess(driver)
    if (process.exitCode) return process.exitCode
    assertIntelReport(JSON.parse(await readFile(path.resolve(output, 'report.json'), 'utf8')), { install: argv.includes('--install') })
    return 0
  } finally { await rm(directory, { recursive: true, force: true }) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runIntelSandbox(process.argv.slice(2))
