import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { inspectText, scanGit, sensitiveFilename } from '../scripts/scan-secrets.mjs'
import { checkSecrets, redactLocations } from '../ci/check-secrets.mjs'
const exec = promisify(execFile)

async function repoFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-secret-policy-test-'))
  await exec('git', ['init', '-q'], { cwd: root })
  await writeFile(path.join(root, 'source.mjs'), '// safe source\n')
  return root
}
test('secret policy identifies credential families without returning credential text', () => {
  const value = ['sk', 'proj', 'x'.repeat(40)].join('-')
  const findings = inspectText(`value=${value}`, 'sample.mjs')
  assert.equal(findings[0].rule, 'provider-key')
  assert.equal(JSON.stringify(findings).includes(value), false)
  assert.ok(inspectText(JSON.stringify({ client_secret: 'v'.repeat(30) }), 'settings.json').some(f => f.rule === 'literal-secret'))
  assert.equal(redactLocations([{ File: value, RuleID: value }])[0].file, '<redacted-filename>')
  assert.equal(redactLocations([{ File: value, RuleID: value }])[0].rule, '<redacted-rule>')
  assert.deepEqual(Object.keys(findings[0]).sort(), ['file', 'line', 'rule'])
  assert.ok(inspectText('-----BEGIN ' + 'PRIVATE KEY-----', 'key.txt').length)
  assert.deepEqual(inspectText('api_key = "${EXTERNAL_SECRET}"', 'sample.mjs'), [])
})
test('ignored local credentials are excluded, but force-staged credential files fail', async () => {
  const root = await repoFixture()
  try {
    await writeFile(path.join(root, '.gitignore'), '.env\n')
    await writeFile(path.join(root, '.env'), 'placeholder-only')
    assert.equal((await scanGit(root)).findings.length, 0)
    await exec('git', ['add', '-f', '.env'], { cwd: root })
    assert.ok((await scanGit(root)).findings.some(f => f.rule === 'sensitive-filename' && f.file === '.env'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('credential stores are blocked while explicit example filenames remain usable', () => {
  for (const file of ['.env', '.env.production', '.npmrc', 'auth.json', 'test.key', 'snapshot.rigbundle']) assert.equal(sensitiveFilename(file), true)
  for (const file of ['.env.example', '.env.sample', 'README.md']) assert.equal(sensitiveFilename(file), false)
})
test('history/worktree reports retain locations only and raw reports are deleted', async () => {
  const root = await repoFixture(), output = await mkdtemp(path.join(tmpdir(), 'orca-secret-results-test-'))
  const temporaryReports = []
  try {
    const marker = 'fixture-only-' + 'do-not-export'
    const execute = async (binary, args) => {
      const report = args.find(a => a.startsWith('--report-path=')).slice('--report-path='.length)
      temporaryReports.push(report)
      assert.ok(args.includes('--redact=100'))
      await writeFile(report, JSON.stringify([{ File: 'source.mjs', StartLine: 1, RuleID: 'fixture-rule', Secret: marker, Match: marker }]))
      throw Object.assign(new Error(marker), { code: 1, stdout: marker, stderr: marker })
    }
    const result = await checkSecrets(root, output, { execute })
    assert.equal(result.ok, false)
    assert.equal(result.historyFindings.length, 1)
    assert.equal(result.worktreeFindings.length, 1)
    assert.equal((await readFile(path.join(output, 'locations.json'), 'utf8')).includes(marker), false)
    for (const report of temporaryReports) await assert.rejects(readFile(report))
  } finally { await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }) }
})
test('scanner startup failures are failures, not clean reports', async () => {
  const root = await repoFixture(), output = await mkdtemp(path.join(tmpdir(), 'orca-secret-failure-test-'))
  try {
    const result = await checkSecrets(root, output, { execute: async () => { throw Object.assign(new Error('not exported'), { code: 'ENOENT' }) } })
    assert.equal(result.ok, false)
    assert.match(result.error, /incomplete/)
    assert.deepEqual(redactLocations([{ File: 'file.mjs', StartLine: 2, RuleID: 'rule', Secret: 'not-exported' }]), [{ file: 'file.mjs', line: 2, rule: 'rule' }])
  } finally { await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true }) }
})
