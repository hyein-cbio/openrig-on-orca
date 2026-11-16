import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, access, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { canStartSeat, canQueueTask, sameSeatDefinition, taskTextError, messageRequest } from '../src/seat-tasks.mjs'
import { stageTaskBody, taskHash, checkTask } from '../src/task-files.mjs'
import { configFrom, seatsFrom } from '../src/runtime.mjs'
import { buildPlan } from '../src/plans.mjs'
const exec = promisify(execFile)
const seat = { key: '["rig-1","dev.worker"]', rigId: 'rig-1', rigName: 'demo', logicalId: 'dev.worker', session: '', runtime: 'pi', status: 'not-started', lifecycle: 'detached', activity: 'unknown', attention: false, model: null, cwd: null }
const running = { ...seat, session: 'dev-worker@demo', status: 'running', lifecycle: 'running', activity: 'working' }

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-seat-task-'))
  const rig = path.join(root, 'rig.mjs'), observed = path.join(root, 'observed.json')
  await writeFile(rig, `import fs from 'node:fs';const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({args,body:args.includes('--body-file')?fs.readFileSync(args[args.indexOf('--body-file')+1],'utf8'):null,url:process.env.OPENRIG_URL,host:process.env.OPENRIG_HOST_SELECTED,kernel:process.env.OPENRIG_NO_KERNEL,source:process.env.RIGGED_SESSION_NAME}));`)
  return { root, observed, config: configFrom({ root: path.join(root, 'data'), homePath: root, provider: 'none', daemonPort: '44673' }), snapshot: { installed: true, ready: false, tools: { rig, node: process.execPath } }, workspace: { id: 'workspace', path: root, hostId: 'local' } }
}

test('registered never-started nodes remain visible without inventing a session address', () => {
  const rows = seatsFrom([{ rigId: seat.rigId, rigName: seat.rigName, logicalId: seat.logicalId, runtime: 'pi', canonicalSessionName: null, sessionStatus: null, lifecycleState: 'detached', model: null, cwd: '/fixture/project' }])
  assert.equal(rows.length, 1); assert.equal(rows[0].session, ''); assert.equal(rows[0].status, 'not-started')
  assert.equal(canStartSeat(rows[0]), true)
  assert.equal(canQueueTask(rows[0]), false)
})
test('launch is single-agent only and task registration permits busy agents, never shell or kernel', () => {
  assert.equal(canStartSeat(seat), true)
  assert.equal(canQueueTask(running), true)
  assert.equal(canStartSeat(running), false)
  for (const bad of [{ rigName: 'kernel' }, { rigNameKnown: false }, { runtime: 'terminal' }, { attention: true }, { rigId: '--all' }, { logicalId: 'a,b' }]) {
    assert.equal(canStartSeat({ ...seat, ...bad }), false)
    assert.equal(canQueueTask({ ...running, ...bad }), false)
  }
  assert.equal(canStartSeat({ ...seat, status: 'unknown' }), false)
  assert.equal(sameSeatDefinition(seat, { ...seat, model: 'changed' }), false)
  assert.equal(sameSeatDefinition(seat, { ...seat, cwd: '/other' }), false)
})
test('task title/body validation supports bounded LF text but rejects control or empty input', () => {
  assert.equal(taskTextError('Inspect diff', 'First line\nSecond line\twith tab'), '')
  for (const [title, body] of [['', 'body'], ['title', ' '], ['x'.repeat(201), 'body'], ['title', 'x'.repeat(4001)], ['a\nb', 'body'], ['title', 'a\x1bb']]) assert.ok(taskTextError(title, body))
})
test('launch command names one rig ID and logical ID, with no subset/fresh/stop/model changes', async () => {
  const f = await fixture()
  try {
    const plan = await buildPlan('launch-seat', f.config, f.snapshot, f.workspace, { seat })
    assert.deepEqual(plan.seatLaunch, seat)
    await exec('/bin/sh', ['-c', plan.command], { env: { HOME: f.root, PATH: '/usr/bin:/bin' } })
    const output = JSON.parse(await readFile(f.observed, 'utf8'))
    assert.deepEqual(output.args, ['launch', '--json', '--', seat.rigId, seat.logicalId])
    assert.equal(output.kernel, '1'); assert.equal(output.host, 'local'); assert.equal(output.url, 'http://127.0.0.1:44673')
    assert.ok(plan.warnings.some(w => w.includes('not a complete native startup plan')))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('queue creation fixes its ID at review and stages a literal private body only after confirmation', async () => {
  const f = await fixture()
  try {
    const body = "First line\n`literal backticks` $(not-a-command) 'quoted'\nLast line"
    const plan = await buildPlan('create-task', f.config, f.snapshot, f.workspace, { seat: running, summary: '--no-nudge is only title text', body })
    const task = plan.queueTask
    assert.match(task.id, /^qitem-orca-[a-f0-9]{32}$/)
    await assert.rejects(access(task.bodyFile))
    await stageTaskBody(f.config.root, task)
    assert.equal((await stat(task.bodyFile)).mode & 0o777, 0o400)
    assert.equal((await stat(path.dirname(task.bodyFile))).mode & 0o777, 0o700)
    await assert.rejects(stageTaskBody(f.config.root, task))
    await exec('/bin/sh', ['-c', plan.command], { env: { HOME: f.root, PATH: '/usr/bin:/bin', RIGGED_SESSION_NAME: 'not-the-operator' } })
    const output = JSON.parse(await readFile(f.observed, 'utf8'))
    assert.equal(output.body, body)
    assert.deepEqual(output.args, ['queue', 'create', '--id', task.id, '--source', 'orca-gui@external', '--destination', running.session, '--summary=--no-nudge is only title text', '--body-file', task.bodyFile, '--json'])
    assert.equal(output.source, undefined)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('Messages uses one Native queue create with fixed identity, external source and default nudge', async () => {
  const f = await fixture()
  try {
    const text = 'Reply to "quoted" input; $(not-a-command)', plan = await buildPlan('send-message', f.config, f.snapshot, f.workspace, { seat: running, message: text, id: 'untrusted', body: 'untrusted' }), task = plan.queueTask
    assert.equal(plan.instruction.text, text); assert.equal(plan.instruction.completion, messageRequest(text, task.id).completion)
    assert.equal(task.body, messageRequest(text, task.id).body); assert.ok(task.body.startsWith(text + '\n\n')); assert.equal(task.body.includes('--no-nudge'), false)
    assert.equal(taskTextError(task.summary, task.body), ''); await assert.rejects(access(task.bodyFile)); await stageTaskBody(f.config.root, task)
    await exec('/bin/sh', ['-c', plan.command], { env: { HOME: f.root, PATH: '/usr/bin:/bin', RIGGED_SESSION_NAME: 'another-seat' } })
    const output = JSON.parse(await readFile(f.observed, 'utf8'))
    assert.deepEqual(output.args, ['queue', 'create', '--id', task.id, '--source', 'orca-gui@external', '--destination', running.session, `--summary=${task.summary}`, '--body-file', task.bodyFile, '--json'])
    assert.equal(output.body, task.body); assert.equal(output.source, undefined); assert.equal(output.args.includes('send'), false); assert.equal(output.args.includes('--no-nudge'), false)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('message summaries and completion hints fit Native bounds without asking the agent to create work', () => {
  const id = `qitem-orca-${'e'.repeat(32)}`
  for (const text of ['Short request', 'x'.repeat(2000), String.fromCodePoint(0x1f44b).repeat(1000), '"'.repeat(2000)]) {
    const request = messageRequest(text, id); assert.equal(taskTextError(request.summary, request.body), ''); assert.ok(request.summary.length <= 200); assert.ok(request.completion.includes(id)); assert.ok(request.completion.includes('--resolution')); assert.equal(request.completion.includes('queue create'), false)
  }
  for (const [text, task] of [['', id], ['x'.repeat(2001), id], ['a\nb', id], ['x', '../invalid']]) assert.throws(() => messageRequest(text, task))
})
test('task readback verifies identity and body while exposing no private body or completion guarantee', async () => {
  const f = await fixture()
  try {
    const id = 'qitem-orca-' + 'a'.repeat(32), body = 'Private fixture body', summary = 'Inspect fixture'
    const record = { id, destination: running.session, summary, bodyHash: taskHash(body), source: 'orca-gui@external', config: JSON.stringify(f.config) }
    const row = { qitemId: id, destinationSession: running.session, sourceSession: 'orca-gui@external', summary: 'Updated final result', body, state: 'done', resolution: String.fromCodePoint(0xac00).repeat(6000) }
    let calls = 0
    const execute = async (file, args, options) => { calls++; assert.deepEqual(args.slice(-6), ['queue', 'show', '--full', '--json', '--', id]); assert.equal(options.env.OPENRIG_HOST_SELECTED, 'local'); return { ok: true, stdout: JSON.stringify(row) } }
    const result = await checkTask(f.config, f.snapshot, record, execute)
    assert.equal(result.registration, 'verified'); assert.equal(result.state, 'done')
    assert.equal(JSON.stringify(result).includes(body), false)
    assert.ok(result.resolution.bytes <= 16384); assert.equal(result.resolution.totalBytes, 18000); assert.equal(result.resolution.truncated, true); assert.equal(result.resolution.body.endsWith(String.fromCodePoint(0xfffd)), false)
    const wrongSource = await checkTask(f.config, f.snapshot, record, async () => ({ ok: true, stdout: JSON.stringify({ ...row, sourceSession: 'other@external' }) }))
    assert.equal(wrongSource.registration, 'unverified'); assert.equal(wrongSource.resolution, undefined)
    assert.match(result.detail, /not proof/)
    const mismatch = await checkTask(f.config, f.snapshot, record, async () => ({ ok: true, stdout: JSON.stringify({ ...row, body: 'other' }) }))
    assert.equal(mismatch.registration, 'unverified')
    const unknown = await checkTask(f.config, f.snapshot, record, async () => ({ ok: false, stdout: '' }))
    assert.equal(unknown.registration, 'unverified')
    const changed = await checkTask({ ...f.config, daemonPort: '44674' }, f.snapshot, record, async () => { throw new Error('Must not query another instance') })
    assert.equal(changed.registration, 'unverified'); assert.equal(calls, 1)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
