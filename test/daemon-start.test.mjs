import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { access, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { configFrom, findExecutable, run } from '../src/runtime.mjs'
import { inspectDaemonTarget, resolveDaemonStart, recheckDaemonStart } from '../src/daemon-start.mjs'
import { buildPlan } from '../src/plans.mjs'

const free = { portFree: async () => true, pidExists: () => false, checkDatabase: async () => {}, checkHolders: async () => {},
  execute: async (_file, _args, { env }) => ({ ok: true, stdout: JSON.stringify({ value: path.join(env.OPENRIG_HOME, 'openrig.sqlite') }) }) }
const header = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84)])
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'openrig daemon #')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, '.openrig'), database = path.join(home, 'openrig.sqlite'), record = path.join(home, 'daemon.json')
  await mkdir(home); await writeFile(database, header)
  const config = configFrom({ root: path.join(root, 'plugin data'), homePath: root, daemonPort: '43811' })
  const rig = path.join(root, 'rig.mjs'); await writeFile(rig, '#!/usr/bin/env node\n')
  return { root, home, database, record, config, rig, snapshot: { installed: true, rigVersion: '0.7.13', tools: { rig, node: process.execPath } } }
}

test('missing TUI record requires an entered port; fresh configured instance uses only its saved path and port', async t => {
  const f = await fixture(t), probes = [], options = { ...free, portFree: async port => { probes.push(port); return true } }
  const tui = await inspectDaemonTarget(f.config, 'tui', undefined, options)
  assert.equal(tui.home, f.home); assert.equal(tui.status, 'port-required'); assert.equal(tui.port, ''); assert.deepEqual(probes, [])
  assert.equal((await inspectDaemonTarget(f.config, 'tui', '22', options)).status, 'port-required')
  const managed = await inspectDaemonTarget(f.config, 'configured', undefined, options)
  assert.equal(managed.home, path.join(f.config.root, 'instance')); assert.equal(managed.port, '43811'); assert.equal(managed.status, 'startable')
  await assert.rejects(access(managed.home), { code: 'ENOENT' })
  const target = await inspectDaemonTarget(f.config, 'tui', '7433', options)
  const resolved = await resolveDaemonStart(f.config, f.snapshot, 'tui', '7433', target.key, options)
  const plan = await buildPlan('start-daemon', resolved.config, f.snapshot, { id: 'work' }, { daemon: resolved.scope })
  assert.equal(plan.daemon.database, f.database); assert.equal(plan.daemon.port, '7433'); assert.equal(plan.daemon.source, 'tui')
  assert.match(plan.command, /--no-kernel/); assert.match(plan.command, /--db/); assert.ok(plan.command.includes(f.database)); assert.ok(plan.warnings.some(w => w.includes(f.database) && w.includes('backup'))); assert.doesNotMatch(plan.command, /--allow-db-conflict/)
  await recheckDaemonStart(f.config, f.snapshot, resolved.scope, options)
  const alias = path.join(f.root, 'alias'); await symlink(f.home, alias)
  const equivalent = { ...options, execute: async () => ({ ok: true, stdout: JSON.stringify({ value: path.join(alias, 'openrig.sqlite') }) }) }
  await recheckDaemonStart(f.config, f.snapshot, resolved.scope, equivalent)
  const lock = path.join(f.home, 'daemon-start.lock'); await writeFile(lock, 'reserved')
  await assert.rejects(recheckDaemonStart(f.config, f.snapshot, resolved.scope, options), /startup reservation/)
  assert.equal(await readFile(lock, 'utf8'), 'reserved')
  const bootId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', earlier = JSON.stringify({ launcherPid: 100, startedAt: '2026-01-01T00:00:00Z', bootId }) + '\n'
  await writeFile(lock, earlier)
  assert.equal((await inspectDaemonTarget(f.config, 'tui', '7433', { ...options, readBootId: async () => bootId })).status, 'blocked')
  assert.equal((await inspectDaemonTarget(f.config, 'tui', '7433', { ...options, readBootId: async () => 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })).status, 'startable')
  assert.equal(await readFile(lock, 'utf8'), earlier); await rm(lock)
  await writeFile(f.rig, '#!/usr/bin/env node\n// Same advertised version, different executable identity.\n')
  await assert.rejects(recheckDaemonStart(f.config, f.snapshot, resolved.scope, options), /executable changed/)
  const custom = { ...options, execute: async () => ({ ok: true, stdout: JSON.stringify({ value: path.join(f.home, 'custom.sqlite') }) }) }
  await assert.rejects(resolveDaemonStart(f.config, f.snapshot, 'configured', undefined, undefined, custom), /configures a different database/)
  await assert.rejects(recheckDaemonStart(f.config, f.snapshot, resolved.scope, custom), /configures a different database/)
  assert.deepEqual(await readFile(f.database), header); await assert.rejects(access(f.record), { code: 'ENOENT' })
  assert.equal(f.config.instanceHome, ''); assert.equal(f.config.daemonPort, '43811')
})

test('the result terminal refuses in-place rewrites of a reviewed existing database', async t => {
  if (!await findExecutable('lsof', { PATH: '/usr/bin:/usr/sbin:/bin:/sbin' })) { t.skip('System lsof is required for the real existing-database terminal guard.'); return }
  const f = await fixture(t)
  const configuredPath = path.join(f.root, 'db-setting')
  await writeFile(configuredPath, f.database)
  await writeFile(f.rig, `import { readFileSync } from 'node:fs';\nif (process.argv[2] === 'config') console.log(JSON.stringify({ value: readFileSync(${JSON.stringify(configuredPath)}, 'utf8') }));\nelse console.log('fixture daemon invoked', process.env.OPENRIG_DAEMON_DB_CONFLICT, process.env.OPENRIG_ALLOW_DB_CONFLICT);\n`)
  const target = await resolveDaemonStart(f.config, f.snapshot, 'tui', '7433', undefined, free)
  const plan = await buildPlan('start-daemon', target.config, f.snapshot, { id: 'work' }, { daemon: target.scope })
  const unchanged = await run('/bin/sh', ['-c', plan.command], { env: { ...process.env, OPENRIG_DAEMON_DB_CONFLICT: 'warn', OPENRIG_ALLOW_DB_CONFLICT: '1' } })
  assert.equal(unchanged.ok, true); assert.match(unchanged.stdout, /fixture daemon invoked stop undefined/)
  const alias = path.join(f.root, 'db-alias.sqlite'); await symlink(f.database, alias); await writeFile(configuredPath, alias)
  assert.match((await run('/bin/sh', ['-c', plan.command])).stdout, /fixture daemon invoked/)
  const different = path.join(f.home, 'other.sqlite'); await writeFile(different, header); await writeFile(configuredPath, different)
  const drift = await run('/bin/sh', ['-c', plan.command]); assert.equal(drift.ok, false); assert.match(drift.stderr, /different database/); assert.equal(drift.stdout, '')
  await writeFile(configuredPath, f.database)
  const holder = await open(f.database, 'r')
  try {
    const occupied = await run('/bin/sh', ['-c', plan.command])
    assert.equal(occupied.ok, false); assert.match(occupied.stderr, /ownership is occupied/); assert.equal(occupied.stdout, '')
  } finally { await holder.close() }
  const rewrite = Buffer.from(header); rewrite[80] = 1; await writeFile(f.database, rewrite)
  await assert.rejects(recheckDaemonStart(f.config, f.snapshot, target.scope, free), /selected instance changed/)
  const changed = await run('/bin/sh', ['-c', plan.command])
  assert.equal(changed.ok, false); assert.match(changed.stderr, /new daemon start review/); assert.doesNotMatch(changed.stdout, /fixture daemon invoked/)
  const updated = await resolveDaemonStart(f.config, f.snapshot, 'tui', '7433', undefined, free)
  const second = await buildPlan('start-daemon', updated.config, f.snapshot, { id: 'work' }, { daemon: updated.scope })
  await writeFile(f.rig, "console.log('fixture replacement invoked')\n")
  const replaced = await run('/bin/sh', ['-c', second.command])
  assert.equal(replaced.ok, false); assert.match(replaced.stderr, /OpenRig executable changed/); assert.equal(replaced.stdout, '')
})

test('a configured existing home can be reviewed explicitly but a mismatched native port, live PID or custom DB cannot', async t => {
  const f = await fixture(t), config = configFrom({ ...f.config, instanceHome: f.home, daemonPort: '7433' })
  const writeRecord = extra => writeFile(f.record, JSON.stringify({ host: '127.0.0.1', port: 7433, pid: 90000, db: f.database, ...extra }))
  assert.equal((await inspectDaemonTarget(config, 'configured', undefined, free)).status, 'startable')
  await writeRecord({})
  const mismatch = await inspectDaemonTarget(config, 'tui', '17433', free)
  assert.equal(mismatch.status, 'blocked'); assert.match(mismatch.detail, /Entered port differs/)
  const stale = await inspectDaemonTarget(config, 'tui', undefined, free)
  assert.equal(stale.status, 'startable'); assert.equal(stale.port, '7433'); assert.equal(stale.portRequired, false)
  const live = await inspectDaemonTarget(config, 'tui', undefined, { ...free, pidExists: () => true })
  assert.equal(live.status, 'blocked'); assert.match(live.detail, /PID/)
  await writeRecord({ port: 17433 }); assert.match((await inspectDaemonTarget(config, 'configured', undefined, free)).detail, /Saved port differs/)
  const other = path.join(f.home, 'other.sqlite'); await writeFile(other, header)
  await writeRecord({ db: other }); assert.match((await inspectDaemonTarget(config, 'tui', undefined, free)).detail, /different database/)
  await writeFile(f.record, '<invalid>'); assert.equal((await inspectDaemonTarget(config, 'tui', '7433', free)).status, 'blocked')
  await rm(f.record); await rm(f.database)
  assert.match((await inspectDaemonTarget(config, 'configured', undefined, free)).detail, /No regular, nonempty/)
  await symlink(other, f.database)
  assert.equal((await inspectDaemonTarget(config, 'tui', '7433', free)).status, 'blocked')
})

test('a reviewed start is blocked on listener appearance, database replacement, record publication or CLI change', async t => {
  const f = await fixture(t), server = createServer(socket => socket.destroy())
  t.after(() => { if (server.listening) server.close() })
  let port
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    const selected = server.address().port
    if (selected >= 1024 && selected <= 65534) { port = String(selected); break }
    await new Promise(resolve => server.close(resolve))
  }
  assert.ok(port, 'Could not allocate a fixture port in the supported range')
  let portFree = true
  const simulated = { ...free, portFree: async () => portFree }
  const reviewed = (await resolveDaemonStart(f.config, f.snapshot, 'tui', port, undefined, simulated)).scope
  portFree = false
  await assert.rejects(recheckDaemonStart(f.config, f.snapshot, reviewed, simulated), /loopback port is occupied/)
  await assert.rejects(recheckDaemonStart(f.config, f.snapshot, reviewed), /loopback port is occupied/)
  await assert.rejects(recheckDaemonStart(f.config, { ...f.snapshot, rigVersion: '0.7.16' }, reviewed, free), /executable changed/)
  await writeFile(f.record, JSON.stringify({ port: Number(port), pid: 90000, db: f.database }))
  await assert.rejects(recheckDaemonStart(f.config, f.snapshot, reviewed, free), /selected instance changed/)
  await rm(f.record)
  await rename(f.database, f.database + '.old'); await writeFile(f.database, header)
  await assert.rejects(recheckDaemonStart(f.config, f.snapshot, reviewed, free), /selected instance changed/)
})
