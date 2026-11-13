import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { prepareLaunchReview, reviewDisplay, stageLaunchProgram } from '../src/launch-review.mjs'
import { buildPlan } from '../src/plans.mjs'
import { configFrom } from '../src/runtime.mjs'

const inspectionFor = hash => ({
  archiveHash: hash, digestValid: true, integrityResult: { passed: true },
  behaviour: {
    schema: 'openrig.bundle-behaviour/v1', state: 'generated',
    team: [{ seat: 'dev.builder', runtime: 'claude-code', profile: 'default' }],
    posture: [{ seat: 'dev.builder', selection: 'acceptEdits', basis: 'declared', nativeEffect: 'unknown' }],
    toldFiles: [{ pathOrRef: 'agents/builder/role.md', resolution: 'archive' }],
    unknownBeforeLaunch: [{ subject: 'native settings', reason: 'Not verified before launch' }]
  }
})
async function fixture(previewStatus = 'planned') {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-launch-test-'))
  const source = path.join(root, 'source'); await mkdir(source)
  const spec = path.join(source, 'rig.yaml'), role = path.join(source, 'role.md'), applied = path.join(root, 'applied.json'), rig = path.join(root, 'rig.mjs')
  await writeFile(spec, JSON.stringify({ permissions: 'reviewed' })); await writeFile(role, 'reviewed role')
  await writeFile(rig, `import fs from 'node:fs';const args=process.argv.slice(2);if(args.includes('--plan'))console.log(JSON.stringify({status:${JSON.stringify(previewStatus)}}));else fs.writeFileSync(${JSON.stringify(applied)},fs.readFileSync(args[1]));`)
  const config = configFrom({ root: path.join(root, 'private'), provider: 'claude' })
  const snapshot = { rigVersion: '0.7.13', tools: { rig, node: process.execPath } }
  const execute = async (file, args) => {
    const archive = args.includes('create') ? args[args.indexOf('--output') + 1] : args.at(-2)
    if (args.includes('create')) {
      await writeFile(archive, JSON.stringify({ spec: await readFile(spec, 'utf8'), role: await readFile(role, 'utf8') }))
      return { ok: true, stdout: '{}' }
    }
    const hash = createHash('sha256').update(await readFile(archive)).digest('hex')
    return { ok: true, stdout: JSON.stringify(inspectionFor(hash)) }
  }
  const review = await prepareLaunchReview(spec, source, config, snapshot, { execute, baseEnv: { HOME: root, PATH: '/usr/bin:/bin' } })
  return { root, spec, role, applied, review }
}
async function runReview(f, onPrompt, answers = 'ACCEPT UNVERIFIED SETTINGS\nLAUNCH\n') {
  await stageLaunchProgram(f.review)
  const child = spawn(process.execPath, [f.review.programPath], { env: { HOME: f.root, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', handled = false
  child.stdout.on('data', chunk => {
    output += chunk.toString()
    if (!handled && output.includes('Type ACCEPT UNVERIFIED SETTINGS')) {
      handled = true
      void Promise.resolve(onPrompt?.()).then(() => child.stdin.end(answers)).catch(error => { child.kill(); throw error })
    }
  })
  child.stderr.on('data', chunk => { output += chunk.toString() })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  return { code, output }
}

test('execution uses frozen spec and referenced role bytes even when the originals change after preview', async () => {
  const f = await fixture()
  try {
    const result = await runReview(f, async () => { await writeFile(f.spec, '{"permissions":"changed"}'); await writeFile(f.role, 'changed role') })
    assert.equal(result.code, 0, result.output)
    const applied = JSON.parse(await readFile(f.applied, 'utf8'))
    assert.equal(JSON.parse(applied.spec).permissions, 'reviewed')
    assert.equal(applied.role, 'reviewed role')
    assert.match(result.output, /UNVERIFIED: inspection did not resolve a model/)
    assert.match(result.output, /acceptEdits/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('tampering with the private archive after preview blocks launch', async () => {
  const f = await fixture()
  try {
    const result = await runReview(f, async () => { await chmod(f.review.archive, 0o600); await writeFile(f.review.archive, 'tampered') })
    assert.equal(result.code, 1)
    assert.match(result.output, /Frozen bundle changed/)
    await assert.rejects(readFile(f.applied))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('LAUNCH alone cannot accept unknown native settings', async () => {
  const f = await fixture()
  try {
    const result = await runReview(f, undefined, 'LAUNCH\n')
    assert.equal(result.code, 1)
    assert.match(result.output, /unverified settings were not accepted/)
    await assert.rejects(readFile(f.applied))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('a zero-exit CLI with a failed preview cannot reach confirmation or launch', async () => {
  const f = await fixture('failed')
  try {
    const result = await runReview(f)
    assert.equal(result.code, 1)
    assert.match(result.output, /complete successful plan/)
    assert.doesNotMatch(result.output, /Type LAUNCH/)
    await assert.rejects(readFile(f.applied))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('expired or changed reviews cannot stage an executable', async () => {
  const f = await fixture()
  try {
    await assert.rejects(stageLaunchProgram({ ...f.review, expires: 0 }), { code: 'plan_stale' })
    await assert.rejects(readFile(f.review.programPath))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('missing permission metadata, bad integrity, and unresolved startup resources fail closed', () => {
  const valid = inspectionFor('a'.repeat(64))
  assert.throws(() => reviewDisplay({ ...valid, digestValid: false }, '/project', valid.archiveHash), { code: 'launch_review_failed' })
  assert.throws(() => reviewDisplay({ ...valid, behaviour: { ...valid.behaviour, posture: [] } }, '/project', valid.archiveHash), { code: 'launch_review_failed' })
  assert.throws(() => reviewDisplay({ ...valid, behaviour: { ...valid.behaviour, toldFiles: [{ resolution: 'external' }] } }, '/project', valid.archiveHash), { code: 'launch_review_failed' })
})
test('unresolved library names cannot enter the verified launch path', async () => {
  const f = await fixture()
  try {
    await assert.rejects(buildPlan('launch-team', configFrom({ provider: 'claude' }), { installed: true, ready: true, tools: { rig: path.join(f.root, 'rig.mjs'), node: process.execPath } }, { id: 'w', path: f.root, hostId: null }, { spec: 'starter' }), { code: 'invalid_spec' })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
