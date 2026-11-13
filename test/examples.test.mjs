import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { exampleBundle, EXAMPLE_STEPS, writeExampleCommand } from '../src/examples.mjs'
import { run, configFrom } from '../src/runtime.mjs'
import { buildPlan } from '../src/plans.mjs'

const id = 'abcdef123456'
test('walkthrough explicitly ends with human acceptance, not fabricated task execution', () => {
  assert.equal(EXAMPLE_STEPS.length, 5)
  assert.equal(EXAMPLE_STEPS[0].speaker, 'You')
  assert.equal(EXAMPLE_STEPS.at(-1).speaker, 'You')
})
test('demo contains two terminal-only roles and explicit simulation notices', () => {
  const bundle = exampleBundle('demo', id, '/example')
  assert.equal((bundle.files['rig.yaml'].match(/runtime: terminal/g) || []).length, 2)
  assert.match(bundle.files['rig.yaml'], /SIMULATION ONLY/)
  assert.doesNotMatch(bundle.files['rig.yaml'], /runtime: (claude-code|codex)/)
  assert.equal(bundle.files['agents/builder/agent.yaml'], undefined)
})
test('real templates use one provider for both seats and do not pin a paid model or bypass', () => {
  for (const kind of ['claude', 'codex']) {
    const bundle = exampleBundle(kind, id, '/example')
    assert.equal((bundle.files['rig.yaml'].match(new RegExp(`runtime: ${kind === 'claude' ? 'claude-code' : 'codex'}`, 'g')) || []).length, 2)
    assert.doesNotMatch(bundle.files['rig.yaml'], /model:|yolo|non_interruptive/)
    assert.match(bundle.files['agents/reviewer/role.md'], /do not edit files/)
    assert.match(bundle.files['agents/builder/agent.yaml'], /version: '1.0'/)
  }
})
test('example materialization is exclusive, quoted, and never writes the selected project', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-example-test-'))
  try {
    const directory = path.join(root, "example's private folder")
    const bundle = exampleBundle('codex', id, directory)
    await assert.rejects(access(directory))
    const result = await run('/bin/sh', ['-c', writeExampleCommand(process.execPath, bundle)])
    assert.equal(result.ok, true, result.stderr)
    assert.equal(await readFile(path.join(directory, 'rig.yaml'), 'utf8'), bundle.files['rig.yaml'])
    const again = await run('/bin/sh', ['-c', writeExampleCommand(process.execPath, bundle)])
    assert.equal(again.ok, false)
    assert.equal(await readFile(path.join(directory, 'project/clamp.mjs'), 'utf8'), bundle.files['project/clamp.mjs'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('template plan creates files but cannot start agents', async () => {
  const config = configFrom({ root: '/private/plugin' })
  const snapshot = { tools: { node: process.execPath }, installed: false }
  const plan = await buildPlan('example-codex', config, snapshot, { id: 'workspace', path: '/user/project', hostId: 'local' })
  assert.equal(plan.example.kind, 'codex')
  assert.match(plan.example.specPath, /private\/plugin\/examples/)
  assert.doesNotMatch(plan.command, /'up'|'daemon'|'login'/)
  assert.deepEqual(plan.writes, [plan.example.directory, '/private/plugin/actions'])
})
test('stopping arbitrary or cross-instance teams is refused', async () => {
  const config = configFrom({ root: '/private/plugin' })
  for (const example of [undefined, { kind: 'codex' }, { kind: 'demo', configRoot: '/different', rigName: `orca-example-demo-${id}` }, { kind: 'demo', configRoot: config.root, rigName: 'important-production-team' }]) {
    await assert.rejects(buildPlan('stop-example', config, { tools: {} }, { id: 'workspace', hostId: null }, { example }), { code: 'example_unowned' })
  }
})
