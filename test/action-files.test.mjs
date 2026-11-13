import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stageAction } from '../src/action-files.mjs'
import { quote, run } from '../src/runtime.mjs'

test('reviewed long commands use short Orca invocations and private exclusive scripts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-action-test-'))
  try {
    const expected = "literal's text " + 'x'.repeat(6000)
    const command = `printf '%s' ${quote(expected)}`
    const staged = await stageAction(root, command)
    assert.ok(staged.command.length < 4096)
    assert.equal((await stat(staged.file)).mode & 0o777, 0o600)
    assert.equal(await readFile(staged.file, 'utf8'), `#!/bin/sh\nexec ${command}\n`)
    const result = await run('/bin/sh', ['-c', staged.command])
    assert.equal(result.ok, true)
    assert.equal(result.stdout, expected)
    const next = await stageAction(root, command)
    assert.notEqual(staged.file, next.file)
  } finally { await rm(root, { recursive: true, force: true }) }
})
