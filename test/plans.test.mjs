import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { buildPlan, fingerprint, PlanStore } from '../src/plans.mjs'
import { configFrom } from '../src/runtime.mjs'

const config = configFrom({ root: '/private/plugin data' })
const workspace = { id: 'workspace-1', path: '/project with spaces', hostId: null }
const snapshot = { platform: 'darwin', installed: true, ready: false, tools: { node: process.execPath, npm: '/usr/local/bin/npm', op: '/usr/local/bin/op', brew: '/opt/homebrew/bin/brew' } }

test('OpenRig install is pinned, private, reviewed and does not run rig setup', async () => {
  const plan = await buildPlan('install-rig', config, snapshot, workspace)
  assert.match(plan.command, /@openrig\/cli@0\.7\.13/)
  assert.match(plan.command, /plugin.*run/)
  // 1Password resolves a plugin by command name, not an absolute npm path.
  assert.match(plan.command, /run.*npm/)
  assert.doesNotMatch(plan.command, /usr\/local\/bin\/npm/)
  assert.match(plan.command, /--prefix/)
  assert.match(plan.command, /plugin data\/runtime/)
  assert.doesNotMatch(plan.command, /install.*-g\b|rig setup|herdr|ghostty/)
  assert.ok(plan.warnings.some(w => w.includes('native SQLite')))
})

test('tmux supports existing brew and Linux package managers, no brew is not a hidden dependency', async () => {
  const brew = await buildPlan('install-tmux', config, snapshot, workspace)
  assert.match(brew.command, /homebrew\/bin\/brew/)
  const linux = await buildPlan('install-tmux', config, { ...snapshot, platform: 'linux', tools: { 'apt-get': '/usr/bin/apt-get', sudo: '/usr/bin/sudo' } }, workspace)
  assert.match(linux.command, /sudo.*apt-get.*install.*tmux/)
  await assert.rejects(buildPlan('install-tmux', config, { ...snapshot, tools: {} }, workspace), { code: 'manual_install_required' })
})

test('no agent is required to start a daemon but no kernel or team starts with it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'openrig-plan-'))
  try {
    const rig = path.join(dir, 'rig.js')
    await writeFile(rig, '#!/usr/bin/env node\n')
    const plan = await buildPlan('start-daemon', config, { ...snapshot, tools: { ...snapshot.tools, rig } }, workspace)
    assert.match(plan.command, /--no-kernel/)
    assert.ok(plan.warnings.some(w => w.includes('OPENRIG_HOME alone')))
    await assert.rejects(buildPlan('launch-team', config, { ...snapshot, tools: { ...snapshot.tools, rig } }, workspace, { spec: 'starter' }), { code: 'agent_setup_required' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('provider package is resolved to an exact official registry version', async () => {
  const urls = []
  const plan = await buildPlan('install-codex', config, snapshot, workspace, {}, {
    fetcher: async url => { urls.push(url); return { ok: true, json: async () => ({ version: '1.2.3' }) } }
  })
  assert.equal(urls[0], 'https://registry.npmjs.org/%40openai%2Fcodex/latest')
  assert.match(plan.command, /@openai\/codex@1\.2\.3/)
  assert.doesNotMatch(plan.command, /@latest/)
})

test('provider installation rejects malformed registry versions before any execution', async () => {
  await assert.rejects(buildPlan('install-codex', config, snapshot, workspace, {}, {
    fetcher: async () => ({ ok: true, json: async () => ({ version: '1.2.3;touch /tmp/no' }) })
  }), { code: 'download_failed' })
})

test('remote workspace operations are refused, never silently run locally', async () => {
  await assert.rejects(buildPlan('install-rig', config, snapshot, { ...workspace, hostId: 'ssh:remote' }), { code: 'local_workspace_required' })
  const local = await buildPlan('install-rig', config, snapshot, { ...workspace, hostId: 'local' })
  assert.equal(local.workspaceId, workspace.id)
})

test('a command too large for complete review is rejected before confirmation', async () => {
  await assert.rejects(buildPlan('install-rig', config, snapshot, workspace, {}, { baseEnv: { PATH: 'x'.repeat(13000), HOME: '/fixture' } }), { code: 'plan_display_too_large' })
})

test('confirmation stores the exact server plan, not a mutable panel command', () => {
  const store = new PlanStore()
  const original = { command: 'safe', action: 'install-rig' }
  const plan = store.add(original, 'config')
  original.command = 'changed'
  plan.command = 'injected'
  assert.equal(store.consume(plan.id, 'config').command, 'safe')
  assert.throws(() => store.consume(plan.id, 'config'), { code: 'plan_expired' })
})

test('plans expire, invalidate after configuration/workspace changes, and are one use', () => {
  let clock = 0
  const store = new PlanStore(() => clock)
  const plan = store.add({ command: 'safe' }, fingerprint(config, workspace))
  assert.throws(() => store.consume(plan.id, fingerprint({ ...config, root: '/different' }, workspace)), { code: 'plan_stale' })
  const expired = store.add({}, 'same')
  clock = 300001
  assert.throws(() => store.consume(expired.id, 'same'), { code: 'plan_expired' })
})
