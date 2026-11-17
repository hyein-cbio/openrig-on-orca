import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { assertLiveReport, cleanCiEnvironment, isolatedProfileSeed, LIVE_CHECKS, optionValue, processSampleState, sandboxConfig, seedFreshOrcaProfile } from '../scripts/ci-support.mjs'
import { configFrom, discover } from '../src/runtime.mjs'
import { verifyArtifact, verifySignature } from '../ci/bootstrap-orca.mjs'
import { validateCell, junitForSteps } from '../ci/run-ci.mjs'
import { ORCA } from '../ci/settings.mjs'

test('first-install sandbox ignores an available external rig before and after its private install', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sandbox-rig-isolation-')))
  try {
    const external = path.join(root, 'external'), bin = path.join(external, 'bin')
    await mkdir(bin, { recursive: true })
    await symlink(process.execPath, path.join(bin, 'node'))
    await writeFile(path.join(bin, 'tmux'), '#!/bin/sh\n', { mode: 0o755 })
    await writeFile(path.join(bin, 'rig'), '#!/usr/bin/env node\n', { mode: 0o755 })
    await writeFile(path.join(external, 'package.json'), JSON.stringify({ name: '@openrig/cli' }))
    const config = sandboxConfig(root, { install: true, rigPath: path.join(bin, 'rig'), daemonPort: 43811, nodePath: path.join(bin, 'node') })
    const probes = []
    let sqliteOk = true
    const options = { baseEnv: { HOME: root, PATH: bin }, platform: 'darwin', arch: 'x64',
      execute: async (file, args) => {
        probes.push({ file, args })
        if (args[0] === '-p') return { ok: true, stdout: JSON.stringify({ version: 'v22.23.4', electron: false }) }
        if (args[0] === '-V') return { ok: true, stdout: 'tmux 3.8\n' }
        if (args.includes('--version')) return { ok: true, stdout: '0.7.13 (fixture)\n' }
        if (args[0] === '-e') return { ok: sqliteOk, stdout: '' }
        throw new Error('Unexpected discovery probe')
      } }
    // Control: the external fixture is discoverable and would satisfy the old empty-path setup.
    assert.equal((await discover(configFrom({ ...config, rigPath: '' }), options)).installed, true)
    probes.length = 0
    const before = await discover(config, options)
    assert.equal(before.tools.rig, null)
    assert.equal(before.installed, false)
    await assert.rejects(access(config.root), { code: 'ENOENT' })
    assert.equal(probes.some(p => p.args.includes('--version') || p.args[0] === '-e'), false)

    const pkg = path.join(config.root, 'runtime', 'node_modules', '@openrig', 'cli')
    await mkdir(path.join(pkg, 'bin'), { recursive: true })
    await mkdir(path.dirname(config.rigPath), { recursive: true })
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openrig/cli' }))
    const entry = path.join(pkg, 'bin', 'rig.mjs')
    await writeFile(entry, '#!/usr/bin/env node\n', { mode: 0o755 })
    await symlink(entry, config.rigPath)
    // Match the real harness's switch to its isolated HOME after installation.
    const installedConfig = configFrom({ ...config, homePath: path.join(root, 'home') })
    const installed = await discover(installedConfig, options)
    assert.equal(installed.tools.rig, config.rigPath)
    assert.equal(installed.installed, true)
    assert.equal(installed.ready, false)
    assert.equal(installed.stage, 'installed-agent-deferred')
    assert.ok(probes.some(p => p.args.includes(entry) && p.args.includes('--version')))
    assert.equal(probes.some(p => p.args.includes(path.join(bin, 'rig')) || p.args.some(a => a.includes(path.join(external, 'package.json')))), false)

    sqliteOk = false
    const broken = await discover(installedConfig, options)
    assert.equal(broken.installed, false)
    assert.equal(broken.tools.rig, config.rigPath)
    await rm(config.rigPath)
    assert.equal((await discover(installedConfig, options)).tools.rig, null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('sandbox without install uses only the explicitly selected existing rig', () => {
  const config = sandboxConfig('/sandbox', { rigPath: './chosen-rig', daemonPort: 43811 })
  assert.equal(config.rigPath, path.resolve('./chosen-rig'))
  assert.equal(config.homePath, '/sandbox/home')
  assert.equal(config.provider, 'none')
  assert.equal(config.nodePath, process.execPath)
})

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
