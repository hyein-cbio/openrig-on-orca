import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { intelConfig, intelHost } from '../src/intel/runtime.mjs'
import { configFrom, environment } from '../src/runtime.mjs'
import { stagePlugin } from '../scripts/stage.mjs'
import { stageIntelPlugin } from '../scripts/stage-intel.mjs'
import { buildIntelHarness } from '../scripts/intel/sandbox.mjs'
import { assertIntelReport } from '../scripts/intel/support.mjs'
import { LIVE_CHECKS } from '../scripts/ci-support.mjs'
import { ORCA } from '../ci/settings.mjs'
import { ORCA_INTEL, requireIntelMac } from '../ci/intel/settings.mjs'
import { installIntelOrca, verifyIntelArtifact } from '../ci/intel/bootstrap-orca.mjs'
import { ensureIntelTmux } from '../ci/intel/ensure-tmux.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

test('shared Apple Silicon implementation, CI, manifest and tests match the reviewed shared-feature baseline', async () => {
  const baseline = JSON.parse(await readFile(path.join(root, 'test/fixtures/apple-silicon-baseline.json'), 'utf8'))
  assert.equal(Object.keys(baseline.files).length, 232)
  for (const [file, expected] of Object.entries(baseline.files)) {
    assert.equal(hash(await readFile(path.join(root, file))), expected, file + ' must remain unchanged; Intel support belongs in additional files')
  }
})

test('Intel path policy preserves explicit paths, adds MacPorts once, and is inert on every other host', () => {
  const input = configFrom({ extraPath: '/chosen/bin' })
  const intel = intelConfig(input, 'darwin', 'x64')
  assert.equal(input.extraPath, '/chosen/bin')
  assert.equal(intel.extraPath, '/chosen/bin:/opt/local/bin')
  assert.deepEqual(intelConfig(intel, 'darwin', 'x64'), intel)
  assert.ok(environment(intel, { PATH: '/usr/bin' }).PATH.includes('/opt/local/bin'))
  for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64'], ['win32', 'x64']]) {
    assert.equal(intelConfig(input, platform, arch), input)
  }
  assert.throws(() => intelConfig({ extraPath: 'relative' }, 'darwin', 'x64'), /absolute/)
})

test('Intel worker adapter reads config without mutating storage, environment or non-config records', async () => {
  const stored = configFrom({ extraPath: '/user/bin' }), receipt = { terminalId: 'owned' }
  const calls = []
  const storage = { async get(key) { calls.push(['get', key]); return key === 'config.v1' ? stored : receipt },
    async set(key, value) { assert.equal(this, storage); calls.push(['set', key, value]) } }
  Object.freeze(storage)
  const orca = Object.freeze({ storage, panels: {}, host: {} }), originalPath = process.env.PATH
  const adapted = intelHost(orca, 'darwin', 'x64')
  assert.deepEqual(calls, [])
  assert.equal((await adapted.storage.get('config.v1')).extraPath, '/user/bin:/opt/local/bin')
  assert.equal(await adapted.storage.get('terminal:owned'), receipt)
  assert.equal(stored.extraPath, '/user/bin')
  assert.equal(process.env.PATH, originalPath)
  assert.equal(adapted.panels, orca.panels)
  await adapted.storage.set('receipt', receipt)
  assert.equal(calls.filter(c => c[0] === 'set').length, 1)
  assert.equal(intelHost(orca, 'darwin', 'arm64'), orca)
  assert.equal(intelHost(orca, 'linux', 'x64'), orca)
})

test('Intel staging selects an additional worker while keeping every original runtime file and grant intact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'intel-stage-test-'))
  try {
    const original = path.join(directory, 'original'), intel = path.join(directory, 'intel')
    await stagePlugin(original); await stageIntelPlugin(intel)
    const a = JSON.parse(await readFile(path.join(original, 'orca-plugin.json'), 'utf8'))
    const b = JSON.parse(await readFile(path.join(intel, 'orca-plugin.json'), 'utf8'))
    assert.equal(a.main, 'src/worker.ts'); assert.equal(b.main, 'src/intel/worker.ts')
    assert.deepEqual({ ...b, main: a.main }, a)
    const baseline = JSON.parse(await readFile(path.join(root, 'test/fixtures/apple-silicon-baseline.json'), 'utf8'))
    for (const file of Object.keys(baseline.files).filter(f => f.startsWith('src/'))) {
      let bytes
      try { bytes = await readFile(path.join(original, file)) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error } // Original staging excludes dev-only files.
      assert.equal(hash(await readFile(path.join(intel, file))), hash(bytes), file)
    }
    assert.match(await readFile(path.join(intel, 'src/intel/worker.ts'), 'utf8'), /activateOriginal/)
    await assert.rejects(stageIntelPlugin(intel), /must be empty/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Intel installer has an independent pin and refuses ARM64 instead of changing the original installer', async () => {
  assert.notEqual(ORCA_INTEL.sha256, ORCA.sha256)
  assert.match(ORCA.url, /macos-arm64/); assert.match(ORCA_INTEL.url, /macos-x64/)
  verifyIntelArtifact(ORCA_INTEL.sha256)
  assert.throws(() => verifyIntelArtifact(ORCA.sha256), /checksum mismatch/)
  requireIntelMac('darwin', 'x64')
  for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64'], ['darwin', 'ia32']]) {
    await assert.rejects(installIntelOrca('/unused', { platform, arch }), /Intel-only/)
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'intel-corrupt-app-'))
  let executions = 0
  try {
    await assert.rejects(installIntelOrca(directory, { platform: 'darwin', arch: 'x64',
      fetcher: async url => { assert.equal(url, ORCA_INTEL.url); return new Response('invalid DMG') },
      execute: async () => { executions++ }
    }), /checksum mismatch/)
    assert.equal(executions, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Intel tmux preflight is explicit verify-only and never enables automatic installation on ARM64', async () => {
  await assert.rejects(ensureIntelTmux({ platform: 'darwin', arch: 'arm64' }), /Intel-only/)
  await assert.rejects(ensureIntelTmux({ platform: 'darwin', arch: 'x64', install: true }), /verify-only/)
  let searchPath
  await assert.rejects(ensureIntelTmux({ platform: 'darwin', arch: 'x64', baseEnv: { PATH: '/chosen/bin' },
    find: async (_name, env) => { searchPath = env.PATH; return null }
  }), /mandatory/)
  assert.ok(searchPath.startsWith('/chosen/bin:'))
  assert.ok(searchPath.split(path.delimiter).includes('/opt/local/bin'))
})

test('Intel tmux preflight discovers user-local tools without relying on an interactive shell profile', async () => {
  let searchPath
  const result = await ensureIntelTmux({ platform: 'darwin', arch: 'x64', baseEnv: { HOME: '/Users/lab', PATH: '/usr/bin:/bin' },
    find: async (name, env) => {
      assert.equal(name, 'tmux'); searchPath = env.PATH
      return env.PATH.split(path.delimiter).includes('/Users/lab/.local/bin') ? '/Users/lab/.local/bin/tmux' : null
    },
    execute: async (_file, args) => ({ ok: true, stdout: args[0] === '-V' ? 'tmux 3.8\n' : args.includes('display-message') ? 'ci-probe\n' : '' })
  })
  assert.ok(searchPath.startsWith('/usr/bin:/bin:'))
  assert.equal(result.path, '/Users/lab/.local/bin/tmux')
  assert.equal(result.installAttempted, false)
  assert.equal(result.socketProbePassed, true)
  await assert.rejects(ensureIntelTmux({ platform: 'darwin', arch: 'x64', find: async () => null }), /docs\/INTEL-CI.md/)
})

test('Intel report strengthens only the additional validation path and rejects missing native evidence', () => {
  const report = { host: { platform: 'darwin', arch: 'x64' }, runtime: { nodeArch: 'x64', worker: { platform: 'darwin', arch: 'x64' }, sqlite: 'ready' },
    exitCode: 0, checks: [...LIVE_CHECKS, 'install-opened', 'first-install'].map(id => ({ id })),
    versions: { node: 'v22.23.4', orca: ORCA.version }, visual: 'captured-seeded-profile' }
  assertIntelReport(report, { install: true })
  for (const changed of [{ host: undefined }, { runtime: undefined }, { runtime: { ...report.runtime, nodeArch: 'arm64' } }, { runtime: { ...report.runtime, sqlite: 'failed' } }]) {
    assert.throws(() => assertIntelReport({ ...report, ...changed }))
  }
})

test('Intel live driver reuses the immutable original harness, selects Intel staging and fails closed on drift', async () => {
  const original = await readFile(path.join(root, 'scripts/sandbox.mjs'), 'utf8')
  const driver = buildIntelHarness(original, root)
  assert.match(driver, /stageIntelPlugin as stagePlugin/)
  assert.match(driver, /file:.*src\/runtime.mjs/)
  assert.match(driver, /report.runtime =/)
  assert.ok(driver.includes('split(/\\s/, 1)'))
  assert.equal(await readFile(path.join(root, 'scripts/sandbox.mjs'), 'utf8'), original)
  assert.throws(() => buildIntelHarness(original.replace("import { stagePlugin } from './stage.mjs'", ''), root), /contract changed/)
  const directory = await mkdtemp(path.join(tmpdir(), 'intel-driver-check-'))
  try {
    const file = path.join(directory, 'driver.mjs'); await writeFile(file, driver)
    execFileSync(process.execPath, ['--check', file])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
