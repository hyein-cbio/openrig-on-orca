import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import { cleanupRunnerDownload, junitForSteps, recordRunnerFailure } from '../ci/run-ci.mjs'
import { configFrom, environment } from '../src/runtime.mjs'
import { persistTerminalReceipt } from '../src/terminal-receipt.mjs'

test('tilde extraPath entries are stored expanded and used by executable discovery', () => {
  const config = configFrom({ extraPath: '~/tools/bin' })
  assert.equal(config.extraPath, path.join(homedir(), 'tools/bin'))
  assert.ok(environment(config, { PATH: '/usr/bin' }).PATH.includes(config.extraPath))
  assert.equal(config.extraPath.includes('~'), false)
})
test('bootstrap, version and report-validation errors become failed JUnit cases', () => {
  for (const message of ['bootstrap failed', 'version mismatch', 'report incomplete']) {
    const summary = { suite: 'orca', steps: [{ suite: 'orca', name: 'previous', seconds: 0, ok: true }], exitCode: 1 }
    recordRunnerFailure(summary, new Error(message))
    assert.equal(summary.steps.at(-1).name, 'runner-validation')
    assert.match(junitForSteps(summary.steps), /failures="1"/)
    assert.equal(summary.exitCode, 1)
  }
  const failed = { suite: 'orca', steps: [{ suite: 'orca', name: 'failed-step', seconds: 0, ok: false }] }
  recordRunnerFailure(failed, new Error('failed step'))
  assert.equal(failed.steps.length, 1)
})
test('runner-owned downloaded apps are removed after successful and failed suites', async () => {
  for (const exitCode of [0, 1]) {
    const directory = await mkdtemp(path.join(tmpdir(), 'orca-download-cleanup-test-'))
    await writeFile(path.join(directory, 'app-fixture'), 'owned test file')
    const summary = { suite: 'orca', steps: [], exitCode }
    await cleanupRunnerDownload(directory, summary)
    await assert.rejects(readFile(path.join(directory, 'app-fixture')))
    assert.equal(summary.exitCode, exitCode)
    assert.equal(summary.bootstrapCleanup, 'complete')
  }
  let called = false
  await cleanupRunnerDownload(undefined, { suite: 'orca', steps: [] }, async () => { called = true })
  assert.equal(called, false, 'An externally supplied Orca installation must not be removed')
})
test('sandbox records only a verified owned PID before enforcing the app version pin', async () => {
  const source = await readFile(new URL('../scripts/sandbox.mjs', import.meta.url), 'utf8')
  const ownership = source.indexOf("assert.ok(appCommand.includes(path.join(root, 'orca'))")
  const recording = source.indexOf('runtimePid = candidatePid')
  const version = source.indexOf("assert.equal(report.versions.orca, '1.4.258'")
  assert.ok(ownership >= 0 && ownership < recording && recording < version)
})

test('metadata failures cannot discard an accepted terminal receipt', async () => {
  for (const storage of [
    { set: async () => { throw new Error('not exported') } },
    { set: () => { throw new Error('not exported') } }
  ]) {
    const result = await persistTerminalReceipt(storage, 'example:fixture', {}, { terminalId: 'accepted-terminal' })
    assert.equal(result.terminalId, 'accepted-terminal')
    assert.match(result.warning, /terminal was opened/)
    assert.doesNotMatch(result.warning, /not exported/)
  }
  const source = await readFile(new URL('../src/terminal-receipt.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\blog\(/, 'Diagnostic logging must not be able to reject the accepted receipt')
})

test('download cleanup failures keep a nonzero exit and a failed testcase', async () => {
  const summary = { suite: 'orca', steps: [], exitCode: 0 }
  await cleanupRunnerDownload('/owned-fixture', summary, async () => { throw new Error('cannot remove') })
  assert.equal(summary.exitCode, 1)
  assert.match(junitForSteps(summary.steps), /failures="1"/)
})
