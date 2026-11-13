import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { assertLiveReport, cleanCiEnvironment, isolatedProfileSeed, LIVE_CHECKS, optionValue, processSampleState, seedFreshOrcaProfile } from '../scripts/ci-support.mjs'
import { verifyArtifact, verifySignature } from '../ci/bootstrap-orca.mjs'
import { validateCell, junitForSteps } from '../ci/run-ci.mjs'
import { ORCA } from '../ci/settings.mjs'

test('onboarding uses a fresh-profile migration seed with telemetry disabled, not a TCC/DB edit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'orca-profile-seed-'))
  try {
    await seedFreshOrcaProfile(directory)
    const seed = JSON.parse(await readFile(path.join(directory, 'orca-data.json'), 'utf8'))
    assert.equal(seed.onboarding.closedAt, 1)
    assert.equal(seed.onboarding.outcome, 'dismissed')
    assert.equal(seed.settings.telemetry.optedIn, false)
    await assert.rejects(seedFreshOrcaProfile(directory), /new empty test profile/)
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'orca-data.json'), 'utf8')), isolatedProfileSeed())
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('CI forwards an allowlist, not credentials or local Orca account/runtime identities', () => {
  const env = cleanCiEnvironment({ PATH: '/bin', HOME: '/tmp/home', NPM_CONFIG_CACHE: '/tmp/cache', CIRCLE_TOKEN: 'secret', SSH_AUTH_SOCK: '/socket', CODEX_HOME: '/private', ORCA_RUNTIME_SOURCE_ID: 'wrong', OPENAI_API_KEY: 'secret', NODE_OPTIONS: 'unsafe', ORCA_CLI_COMMAND: '/test/orca' })
  assert.deepEqual(env, { PATH: '/bin', HOME: '/tmp/home', NPM_CONFIG_CACHE: '/tmp/cache', ORCA_CLI_COMMAND: '/test/orca', CI: 'true' })
})
test('live report must prove all lifecycle checks and cleanup without skips', () => {
  const report = { exitCode: 0, checks: [...LIVE_CHECKS, 'install-opened', 'first-install'].map(id => ({ id })), versions: { node: 'v22.23.4', orca: ORCA.version }, visual: 'captured-seeded-profile' }
  assertLiveReport(report, { install: true })
  assert.throws(() => assertLiveReport({ ...report, checks: report.checks.filter(c => c.id !== 'cleanup-complete') }, { install: true }), /cleanup-complete/)
  assert.throws(() => assertLiveReport({ ...report, error: 'failed' }), /did not succeed/)
  assert.throws(() => assertLiveReport({ ...report, visual: 'not-captured' }), /capture/)
})
test('CI cell policy does not misrepresent Apple silicon Node 24 as a live OpenRig target', () => {
  validateCell('core', '22.23.4'); validateCell('core', '24.22.1'); validateCell('orca', '22.23.4')
  assert.throws(() => validateCell('orca', '24.22.1'), /Unsupported/)
})
test('bootstrap verifies checksum and publisher before executing the pinned app', () => {
  verifyArtifact(ORCA.sha256)
  assert.throws(() => verifyArtifact('0'.repeat(64)), /checksum mismatch/)
  verifySignature(`Identifier=${ORCA.bundleId}\nTeamIdentifier=${ORCA.teamId}\n`)
  assert.throws(() => verifySignature('Identifier=other\nTeamIdentifier=other'), /publisher/)
})
test('JUnit escapes step names without dumping secret-bearing command output', () => {
  const xml = junitForSteps([{ suite: 'core', name: 'a<&"', seconds: 1, ok: false, stdout: 'NOT_INCLUDED_SECRET' }])
  assert.match(xml, /a&lt;&amp;&quot;/)
  assert.doesNotMatch(xml, /NOT_INCLUDED_SECRET/)
  assert.match(xml, /failures="1"/)
})
test('CircleCI uses managed macOS, pinned versions and no credential context or remote retries', async () => {
  const config = await readFile(new URL('../.circleci/config.yml', import.meta.url), 'utf8')
  for (const pin of ['26.4.1', 'm4pro.medium', 'circleci/node@7.2.1', '22.23.4', '24.22.1']) assert.ok(config.includes(pin))
  assert.doesNotMatch(config, /self-hosted|context:|pull_request_target|automatic_reruns/)
  assert.match(config, /store_test_results/); assert.match(config, /store_artifacts/)
  assert.match(config, /node ci\/ensure-tmux\.mjs --install/)
  assert.doesNotMatch(config, /command -v tmux.*\|\| brew install/)
})
test('cleanup waits on macOS exit transitions but never treats an unrelated live PID as owned', () => {
  assert.equal(processSampleState('', ['/test']), 'gone')
  assert.equal(processSampleState('Z (Orca)', ['/test']), 'gone')
  assert.equal(processSampleState('?E (Orca)', ['/test']), 'exiting')
  assert.equal(processSampleState('S /app/Orca --user-data-dir=/test/profile', ['/test']), 'owned')
  assert.equal(processSampleState('S /app/Orca --user-data-dir=/personal', ['/test']), 'unproven')
})

test('CLI options reject missing and repeated values', () => {
  assert.equal(optionValue(['--output', '/tmp/report'], '--output'), '/tmp/report')
  assert.throws(() => optionValue(['--output', '--install'], '--output'))
  assert.throws(() => optionValue(['--output', '/tmp/a', '--output', '/tmp/b'], '--output'))
})
