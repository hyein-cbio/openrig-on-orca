import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, access, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { absolute, configFrom, environment, commandEnvironment, discover, nodeSupported, quote, run, seatsFrom, rigInvocation, listSeats } from '../src/runtime.mjs'

test('configuration rejects unknown fields, relative paths, shell lines and provider typos', () => {
  for (const value of [{ provider: 'magic' }, { daemonPort: '0' }, { daemonPort: '65535' }, { daemonPort: '43811;id' }, { nodePath: 'node' }, { root: '/' }, { tmuxPath: '/bin/tmux\nwhoami' }, { constructor: 'oops' }, { extraPath: '/bin:relative' }]) {
    assert.throws(() => configFrom(value), { code: 'invalid_config' })
  }
  assert.equal(absolute('~/tool', 'tool', '/test-home'), '/test-home/tool')
  assert.equal(configFrom({ provider: 'none' }).provider, 'none')
})

test('supported runtime policy includes the Apple silicon Node 22 constraint', () => {
  assert.equal(nodeSupported('v22.23.1', 'darwin', 'arm64'), true)
  assert.equal(nodeSupported('24.1.0', 'darwin', 'arm64'), false)
  assert.equal(nodeSupported('24.1.0', 'linux', 'x64'), true)
  for (const version of ['20.9.0', '23.0.0', '26.0.0', 'oops']) assert.equal(nodeSupported(version), false)
})

test('instance environment removes parent identities but preserves ordinary credentials without reading them', () => {
  const config = configFrom({ root: '/private/plugin', nodePath: '/node/bin/node', tmuxPath: '/tmux/bin/tmux' })
  const env = environment(config, { HOME: '/person', PATH: '/usr/bin', OPENRIG_NODE_ID: 'seat', OPENRIG_DAEMON_URL: 'wrong', TMUX: 'other', CODEX_HOME: '/existing', API_KEY: 'not-read', NODE_OPTIONS: 'unsafe' })
  assert.equal(env.OPENRIG_HOME, '/private/plugin/instance')
  assert.equal(env.OPENRIG_NODE_ID, undefined)
  assert.equal(env.OPENRIG_DAEMON_URL, undefined)
  assert.equal(env.TMUX, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.CODEX_HOME, '/existing')
  assert.equal(env.API_KEY, 'not-read')
  assert.ok(env.PATH.startsWith('/node/bin:/tmux/bin:'))
  const isolated = environment(configFrom({ homePath: '/sandbox', codexHome: '/sandbox/codex' }), { HOME: '/person', CODEX_HOME: '/person/codex', CLAUDE_CONFIG_DIR: '/person/claude' })
  assert.equal(isolated.HOME, '/sandbox')
  assert.equal(isolated.CODEX_HOME, '/sandbox/codex')
  assert.equal(isolated.CLAUDE_CONFIG_DIR, undefined)
})

test('shell quoting preserves hostile-looking arguments literally', async () => {
  const value = "spaces ' quote; $(printf injected) \`whoami\`"
  const result = await run('/bin/sh', ['-c', "printf '%s' " + quote(value)])
  assert.equal(result.stdout, value)
  assert.equal(result.ok, true)
})

test('terminal environment clears stale account paths when sandbox HOME is chosen', async () => {
  const config = configFrom({ root: '/sandbox/data', homePath: '/sandbox/home' })
  const base = { HOME: '/real', CODEX_HOME: '/secret', CLAUDE_CONFIG_DIR: '/secret-claude', OPENRIG_NODE_ID: 'wrong', PATH: '/usr/bin:/bin' }
  const prefix = commandEnvironment(config, { tools: {} }, base)
  const result = await run('/bin/sh', ['-c', prefix + " printf '%s|%s|%s|%s' \"$HOME\" \"$CODEX_HOME\" \"$CLAUDE_CONFIG_DIR\" \"$OPENRIG_NODE_ID\""], { env: base })
  assert.equal(result.stdout, '/sandbox/home|||')
})

test('discovery is read-only and does not require an agent, gh, docker or workspace apps', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'openrig-probe-'))
  try {
    const config = configFrom({ root: path.join(dir, 'not-created'), nodePath: process.execPath, rigPath: '/does-not-exist', tmuxPath: '/does-not-exist', provider: 'none' })
    const result = await discover(config, { baseEnv: { HOME: dir, PATH: '/usr/bin:/bin' }, platform: 'linux', arch: 'x64' })
    assert.equal(result.stage, 'dependencies-missing')
    assert.deepEqual(result.providers, [])
    assert.equal(result.tools.rig, null)
    assert.equal(result.tools.tmux, null)
    await assert.rejects(access(config.root))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('missing instance state never queries a daemon on a fallback port', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'openrig-no-state-'))
  let calls = 0
  try {
    await assert.rejects(listSeats(configFrom({ root: dir }), { tools: { node: process.execPath, rig: '/not-used', tmux: '/not-used' } }, async () => { calls++; return { ok: true, stdout: '[]' } }), { code: 'daemon_unavailable' })
    assert.equal(calls, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('native Windows is refused rather than trying POSIX commands', async () => {
  await assert.rejects(discover(configFrom(), { platform: 'win32' }), { code: 'unsupported_platform' })
})

test('npm rig wrappers run with selected Node, not an arbitrary shebang runtime', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'openrig-entry-'))
  try {
    const file = path.join(dir, 'rig.js')
    await writeFile(file, '#!/usr/bin/env node\nconsole.log(1)')
    assert.deepEqual(await rigInvocation(file, '/chosen/node'), { file: '/chosen/node', args: [await realpath(file)] })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('seat identity survives occupant/session changes and arbitrary attach commands are ignored', () => {
  const row = { rigId: 'r', logicalId: 'build.agent', rigName: 'Demo', canonicalSessionName: 'first@demo', sessionStatus: 'running', needsAttention: true, tmuxAttachCommand: 'touch /never' }
  const first = seatsFrom([row])[0]
  const next = seatsFrom({ entries: [{ ...row, canonicalSessionName: 'successor@demo' }], truncated: false })[0]
  assert.throws(() => seatsFrom({ entries: [row], truncated: true }), { code: 'seat_list_truncated' })
  assert.equal(first.key, next.key)
  assert.equal(first.attention, true)
  assert.equal(first.tmuxAttachCommand, undefined)
  assert.throws(() => seatsFrom({ unexpected: [] }), { code: 'invalid_rig_output' })
  assert.deepEqual(seatsFrom([{}, null]), [])
})
