import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHarnessCancellation } from '../scripts/intel/cancellation.mjs'
import { buildIntelHarness } from '../scripts/intel/sandbox.mjs'
import { cleanupIntelStaging, sandboxCleanupVerified } from '../ci/intel/run-ci.mjs'
import { junitForSteps } from '../ci/run-ci.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const execute = (file, args, options) => new Promise(resolve => {
  execFile(file, args, options, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
})

test('real execFile timeout waits for in-process harness cancellation and owned cleanup', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'intel-timeout-regression-'))
  const marker = name => path.join(directory, name)
  const cancellationUrl = pathToFileURL(path.join(root, 'scripts/intel/cancellation.mjs')).href
  const sandboxUrl = pathToFileURL(path.join(root, 'scripts/intel/sandbox.mjs')).href
  const command = `const {spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},50)"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker('pids'))},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},50)`
  try {
    await writeFile(marker('driver.mjs'), `
      import assert from 'node:assert/strict'
      import { writeFile } from 'node:fs/promises'
      import { createHarnessCancellation } from ${JSON.stringify(cancellationUrl)}
      const lifetime = createHarnessCancellation({ graceMs: 100 })
      try {
        await lifetime.execute(process.execPath, ['-e', ${JSON.stringify(command)}])
        throw new Error('The timed out command unexpectedly succeeded')
      } catch (error) {
        assert.equal(error.name, 'AbortError')
        await assert.rejects(lifetime.execute(process.execPath, ['-e', ${JSON.stringify('require("node:fs").writeFileSync(' + JSON.stringify(marker('forbidden')) + ',"bad")')}]), /cancelled/)
        await writeFile(${JSON.stringify(marker('blocked'))}, 'normal commands blocked')
      } finally {
        await lifetime.beginCleanup()
        await lifetime.execute(process.execPath, ['-e', ${JSON.stringify('setTimeout(()=>require("node:fs").writeFileSync(' + JSON.stringify(marker('cleaned')) + ',"owned cleanup complete"),200)')}])
        await lifetime.finishCleanup()
        lifetime.dispose()
      }
    `)
    await writeFile(marker('wrapper.mjs'), `
      import { runHarnessInProcess } from ${JSON.stringify(sandboxUrl)}
      import { writeFile } from 'node:fs/promises'
      await runHarnessInProcess(${JSON.stringify(marker('driver.mjs'))})
      await writeFile(${JSON.stringify(marker('returned'))}, 'wrapper returned after cleanup')
    `)
    const result = await execute(process.execPath, [marker('wrapper.mjs')], { timeout: 2000 })
    assert.ok(result.error, result.stderr)
    assert.equal(result.error.killed, true, result.stderr)
    assert.equal(await readFile(marker('blocked'), 'utf8'), 'normal commands blocked')
    assert.equal(await readFile(marker('cleaned'), 'utf8'), 'owned cleanup complete')
    assert.equal(await readFile(marker('returned'), 'utf8'), 'wrapper returned after cleanup')
    await assert.rejects(access(marker('forbidden')))
    for (const pid of JSON.parse(await readFile(marker('pids'), 'utf8'))) {
      const observed = await execute('ps', ['-p', String(pid), '-o', 'stat='])
      assert.ok(observed.error?.code === 1 || /^\s*Z/.test(observed.stdout), 'Owned command still running: ' + pid)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('repeated cancellation never aborts cleanup commands and signal listeners are restored', async () => {
  const target = new EventEmitter()
  const lifetime = createHarnessCancellation({ processTarget: target, graceMs: 20 })
  try {
    target.emit('SIGINT'); target.emit('SIGTERM')
    assert.equal(lifetime.signal, 'SIGINT')
    assert.equal(target.exitCode, 1)
    assert.throws(() => lifetime.execFile(process.execPath, ['-e', 'process.exit(0)'], {}, () => {}), /cancelled/)
    await lifetime.beginCleanup()
    const cleanup = lifetime.execute(process.execPath, ['-e', 'setTimeout(()=>console.log("cleaned"),100)'])
    target.emit('SIGTERM')
    assert.equal((await cleanup).stdout.trim(), 'cleaned')
    await lifetime.finishCleanup()
  } finally { lifetime.dispose() }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(target.listenerCount(signal), 0)
})

test('a first cancellation received during cleanup lets cleanup finish but still fails the run', async () => {
  const target = new EventEmitter()
  const lifetime = createHarnessCancellation({ processTarget: target, graceMs: 20 })
  try {
    await lifetime.beginCleanup()
    const cleanup = lifetime.execute(process.execPath, ['-e', 'setTimeout(()=>console.log("cleanup finished"),100)'])
    target.emit('SIGTERM')
    assert.equal((await cleanup).stdout.trim(), 'cleanup finished')
    assert.equal(target.exitCode, 1)
    await lifetime.finishCleanup()
  } finally { lifetime.dispose() }
})

test('a command timeout terminates its owned group and awaits close before rejecting', async () => {
  const lifetime = createHarnessCancellation({ processTarget: new EventEmitter(), graceMs: 20 })
  try {
    await assert.rejects(lifetime.execute(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},50)'], { timeout: 100 }), { code: 'ETIMEDOUT' })
    await lifetime.beginCleanup()
    await lifetime.finishCleanup()
  } finally { lifetime.dispose() }
})

test('generated Intel driver guards retries and always enters owned cleanup without changing the original', async () => {
  const original = await readFile(path.join(root, 'scripts/sandbox.mjs'), 'utf8')
  const driver = buildIntelHarness(original, root, ['--install', '--output', '/test/output'])
  assert.match(driver, /const exec = cancellation.execute/)
  assert.match(driver, /while \(Date.now\(\) < deadline\) \{\n    cancellation.throwIfCancelled\(\)/)
  assert.match(driver, /await cancellation.beginCleanup\(\)/)
  assert.match(driver, /await cancellation.finishCleanup\(\)/)
  assert.match(driver, /cancellation.dispose\(\)/)
  assert.match(driver, /report.cleanup =/)
  assert.match(driver, /if \(action === 'start-daemon'\) daemonStarted = true/)
  assert.equal(await readFile(path.join(root, 'scripts/sandbox.mjs'), 'utf8'), original)
})

test('runner-owned staging is removed after success, partial staging and failed inspection', async () => {
  for (const phase of ['success', 'stage-failure', 'inspect-failure']) {
    const directory = await mkdtemp(path.join(tmpdir(), 'openrig-intel-plugin-test-'))
    const summary = { suite: 'orca', steps: [], exitCode: 0 }
    try {
      try {
        await writeFile(path.join(directory, 'package-fixture'), 'partially or fully staged')
        if (phase !== 'success') throw new Error(phase)
      } catch (error) { assert.equal(error.message, phase) }
      finally { await cleanupIntelStaging(directory, summary) }
      await assert.rejects(access(directory))
      assert.equal(summary.stagingCleanup, 'complete')
      assert.equal(summary.steps.at(-1).name, 'staging-cleanup')
      assert.equal(summary.steps.at(-1).ok, true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  const source = await readFile(path.join(root, 'ci/intel/run-ci.mjs'), 'utf8')
  assert.match(source, /stagingDirectory = await mkdtemp/)
  assert.ok(source.includes("['scripts/stage-intel.mjs', stagingDirectory]"))
  assert.ok(source.includes("['plugin', 'inspect', stagingDirectory, '--json']"))
  assert.match(source, /finally \{\n    await cleanupIntelStaging\(stagingDirectory, summary\)/)
})

test('staging cleanup failure fails CI/JUnit and absent owned paths never remove external files', async () => {
  const summary = { suite: 'orca', steps: [], exitCode: 0 }
  await cleanupIntelStaging('/owned/stage', summary, async () => { throw new Error('fixture deletion refused') })
  assert.equal(summary.exitCode, 1)
  assert.equal(summary.steps.at(-1).ok, false)
  assert.match(junitForSteps(summary.steps), /failures="1"/)
  let called = false
  await cleanupIntelStaging(undefined, summary, async () => { called = true })
  assert.equal(called, false)
})

test('download removal requires a current explicit successful cleanup receipt, not just test exit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'intel-cleanup-receipt-'))
  try {
    assert.equal(await sandboxCleanupVerified(directory), false)
    for (const [report, expected] of [
      [{ exitCode: 0, warnings: [] }, false],
      [{ exitCode: 1, cancelled: 'SIGTERM', cleanup: { completed: true }, warnings: [] }, true],
      [{ cleanup: { completed: false }, warnings: [] }, false],
      [{ cleanup: { completed: true }, warnings: ['cleanup incomplete'] }, false]
    ]) {
      await writeFile(path.join(directory, 'report.json'), JSON.stringify(report))
      assert.equal(await sandboxCleanupVerified(directory), expected)
    }
    await writeFile(path.join(directory, 'report.json'), 'invalid JSON')
    assert.equal(await sandboxCleanupVerified(directory), false)
    const source = await readFile(path.join(root, 'ci/intel/run-ci.mjs'), 'utf8')
    assert.match(source, /await rm\(path.join\(output, 'report.json'\), \{ force: true \}\)/)
    assert.match(source, /if \(safeToRemove\) await cleanupRunnerDownload/)
    assert.match(source, /retained-unverified-sandbox/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
