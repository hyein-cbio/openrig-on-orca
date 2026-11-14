import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildPlan } from '../src/plans.mjs'
import { canInstruct, instructionTextError } from '../src/seat-instructions.mjs'
import { configFrom, listInstructionSeats } from '../src/runtime.mjs'
const exec = promisify(execFile)
const seat = { key: '["rig-1","dev.worker"]', rigId: 'rig-1', rigName: 'demo', logicalId: 'dev.worker', session: 'dev-worker@demo', runtime: 'pi', status: 'running', activity: 'idle', attention: false }

test('instruction targeting accepts idle agents only, never shells, busy seats or host-qualified targets', () => {
  for (const runtime of ['pi', 'claude-code', 'codex']) assert.equal(canInstruct({ ...seat, runtime }), true)
  for (const overrides of [{ runtime: 'terminal' }, { runtime: 'unknown' }, { status: 'stopped' }, { activity: 'working' }, { activity: 'unknown' }, { attention: true }, { session: 'worker@demo@remote' }, { session: '--pod' }]) assert.equal(canInstruct({ ...seat, ...overrides }), false)
})

test('instruction text is bounded, single-line, and rejects control input', () => {
  for (const text of ['', '   ', 1, 'x'.repeat(2001), 'a\nb', 'a\rb', 'a\x1bb', 'a\x00b', 'a\u2028b', 'a\u2029b']) assert.ok(instructionTextError(text))
  assert.equal(instructionTextError('Please inspect the latest diff.'), '')
  assert.equal(instructionTextError(String.fromCodePoint(0xac00)), '')
})

test('reviewed instruction executes exactly one literal send through the selected CLI and local endpoint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-instruction-'))
  try {
    const rig = path.join(root, 'rig.mjs'), observed = path.join(root, 'observed.json'), sentinel = path.join(root, 'must-not-exist')
    await writeFile(rig, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({args:process.argv.slice(2),url:process.env.OPENRIG_URL,host:process.env.OPENRIG_HOST_SELECTED,identity:process.env.OPENRIG_SESSION_NAME}));`)
    const config = configFrom({ root: path.join(root, "private ' data"), provider: 'none', daemonPort: '44672' })
    const snapshot = { installed: true, ready: false, tools: { rig, node: process.execPath } }
    const baseEnv = { PATH: '/usr/bin:/bin', HOME: root, OPENRIG_URL: 'http://127.0.0.1:9999', RIGGED_URL: 'http://127.0.0.1:9998', OPENRIG_HOST_SELECTED: 'remote', OPENRIG_SESSION_NAME: 'another-seat' }
    const message = `--to other-seat; $(touch '${sentinel}') "quoted" instruction`
    const plan = await buildPlan('send-instruction', config, snapshot, { id: 'workspace', path: root, hostId: 'local' }, { seat, message }, { baseEnv })
    assert.equal(plan.instruction.text, message)
    assert.equal(plan.instruction.key, seat.key)
    assert.ok(plan.warnings.some(w => w.includes('not a durable queue task')))
    assert.ok(plan.writes.some(w => w.includes('paid model')))
    await exec('/bin/sh', ['-c', plan.command], { env: baseEnv })
    const result = JSON.parse(await readFile(observed, 'utf8'))
    assert.deepEqual(result.args, ['send', '--wait-for-idle', '1', '--json', '--', seat.session, message])
    assert.equal(result.url, 'http://127.0.0.1:44672')
    assert.equal(result.host, 'local')
    assert.equal(result.identity, undefined)
    await assert.rejects(access(sentinel))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('invalid instructions or unsafe targets cannot produce a runnable plan', async () => {
  const config = configFrom({ provider: 'none' })
  const snapshot = { installed: true, tools: { rig: '/not-used', node: process.execPath } }
  const workspace = { id: 'workspace', path: '/fixture', hostId: 'local' }
  await assert.rejects(buildPlan('send-instruction', config, snapshot, workspace, { seat: { ...seat, runtime: 'terminal' }, message: 'test' }), { code: 'seat_unavailable' })
  await assert.rejects(buildPlan('send-instruction', config, snapshot, workspace, { seat, message: '\r' }), { code: 'invalid_instruction' })
})

test('instruction seat lookup is read-only and cannot inherit a remote selection or legacy endpoint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-instruction-list-'))
  try {
    await mkdir(path.join(root, 'instance'))
    await writeFile(path.join(root, 'instance', 'daemon.json'), '{}')
    const rig = path.join(root, 'rig.mjs'); await writeFile(rig, '// fixture\n')
    let observed
    const seats = await listInstructionSeats(configFrom({ root, daemonPort: '44672' }), { tools: { rig, node: process.execPath, tmux: '/fixture/tmux' } }, async (file, args, options) => {
      observed = { args, env: options.env }
      return { ok: true, stdout: JSON.stringify([{ rigId: seat.rigId, rigName: seat.rigName, logicalId: seat.logicalId, canonicalSessionName: seat.session, runtime: 'pi', sessionStatus: 'running', agentActivity: { state: 'idle' } }]) }
    }, { HOME: root, OPENRIG_HOST_SELECTED: 'remote', RIGGED_URL: 'http://127.0.0.1:9999' })
    assert.equal(seats[0].key, seat.key)
    assert.equal(observed.env.OPENRIG_URL, 'http://127.0.0.1:44672')
    assert.equal(observed.env.OPENRIG_HOST_SELECTED, 'local')
    assert.ok(observed.args.includes('--no-cleanup'))
    assert.equal(observed.args.includes('send'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
