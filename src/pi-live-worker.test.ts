import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { mockHost, mountWorker } from 'orca/testing'
import * as workerModule from './worker'
import { configFrom } from './runtime.mjs'
import type { PiLiveBatch } from './protocol'

const record = (type: string, rest: object) => JSON.stringify({ type, ...rest }) + '\n'
const entry = (text: string) => record('message', { message: { role: 'user', content: text } })
test('loaded Live Pi worker follows verified changes only within the exact Native seat', async t => {
  const rig = process.env.OPENRIG_TEST_RIG
  if (!rig) { t.skip('Set OPENRIG_TEST_RIG to use the installed SQLite binding with a synthetic Native seat'); return }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-live-pi-worker-')))
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    let directory = path.dirname(await realpath(rig)), packageFile: string | undefined
    for (; directory !== path.dirname(directory); directory = path.dirname(directory)) {
      try { if (JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')).name === '@openrig/cli') { packageFile = path.join(directory, 'package.json'); break } } catch { /* Walk the selected executable's installation. */ }
    }
    assert.ok(packageFile)
    const require = createRequire(packageFile), sqlite = path.dirname(require.resolve('better-sqlite3/package.json'))
    const home = path.join(root, 'Native'), session = 'leader@fixture', state = path.join(home, 'state', 'pi', session), history = path.join(state, 'sessions')
    const exact = path.join(history, 'older exact.jsonl'), sibling = path.join(history, 'latest.jsonl'), replacement = path.join(history, 'new occupant.jsonl')
    await mkdir(history, { recursive: true }); await mkdir(path.join(root, 'node_modules')); await symlink(sqlite, path.join(root, 'node_modules', 'better-sqlite3'))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@openrig/cli', type: 'module' }))
    const original = record('session', { version: 3, id: 'exact' }) + entry('EXACT SEAT')
    await writeFile(exact, original)
    await writeFile(sibling, record('session', { version: 3, id: 'latest' }) + entry('DO NOT FOLLOW LATEST'))
    const sidecar = path.join(state, 'runner-state.json')
    const runner = (file: string, id: string, summary?: string, launchId = `launch-${id}`) => writeFile(sidecar, JSON.stringify({ ready: true, launchId, sessionFile: file, sessionId: id, compaction: summary && { result: { summary } } }))
    await runner(exact, 'exact', 'compacted synthetic context '.repeat(1024)); await writeFile(path.join(home, 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port: 17433, db: path.join(home, 'openrig.sqlite') }))
    const Database = require('better-sqlite3'), dbFile = path.join(home, 'openrig.sqlite'), db = new Database(dbFile)
    try {
      db.exec('CREATE TABLE rigs(id TEXT,archived_at TEXT); CREATE TABLE nodes(id TEXT,rig_id TEXT,logical_id TEXT,pod_id TEXT,runtime TEXT); CREATE TABLE sessions(id INTEGER,node_id TEXT,session_name TEXT,resume_type TEXT,resume_token TEXT); CREATE TABLE bindings(node_id TEXT,tmux_session TEXT);')
      db.prepare('INSERT INTO rigs VALUES (?,NULL)').run('rig-fixture')
      db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?)').run('node-fixture', 'rig-fixture', 'dev.leader', 'pod-fixture', 'pi')
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(1, 'node-fixture', session, 'pi_session_file', exact)
      db.prepare('INSERT INTO bindings VALUES (?,?)').run('node-fixture', session)
    } finally { db.close() }
    const row = { rigId: 'rig-fixture', rigName: 'fixture', logicalId: 'dev.leader', podId: 'pod-fixture', podNamespace: 'dev', canonicalSessionName: session, runtime: 'pi', sessionStatus: 'running', agentActivity: { state: 'working' } }
    const cli = path.join(root, 'rig.mjs'), tmux = path.join(root, 'tmux')
    await writeFile(cli, `#!/usr/bin/env node\nconst arg=process.argv[2];if(arg==='--version')console.log('0.7.13');else if(arg==='ps')console.log(${JSON.stringify(JSON.stringify([row]))});else process.exitCode=1`, { mode: 0o700 })
    await writeFile(tmux, '#!/bin/sh\nprintf "tmux fixture"', { mode: 0o700 })
    const config = configFrom({ root, instanceHome: home, homePath: root, daemonPort: '17433', nodePath: process.execPath, rigPath: cli, tmuxPath: tmux })
    const host = mockHost({ storage: { 'config.v1': config }, results: { 'workspace.list': { workspaces: [], truncated: false } } })
    worker = await mountWorker(workerModule, { host })
    const inventory = await worker.request('pods.list', { source: 'configured' }), id = 'a'.repeat(32)
    const scope = { source: 'configured' as const, instanceKey: inventory.connection.key, podKey: inventory.pods[0].key, seatKey: inventory.seats[0].key, session }
    await assert.rejects(worker.request('pi-live.start', { ...scope, session: 'changed@fixture', id }), /Live Pi stopped/)
    const initial = await worker.request('pi-live.start', { ...scope, id })
    assert.deepEqual(initial.events.map(e => e.text), ['EXACT SEAT'])
    assert.deepEqual(Object.keys(initial).sort(), ['events', 'id', 'more', 'omittedHistory', 'skippedRecords'])
    await appendFile(exact, entry('REAL APPEND'))
    assert.deepEqual((await worker.request('pi-live.read', { id })).events.map(e => e.text), ['REAL APPEND'])
    assert.deepEqual((await worker.request('pi-live.read', { id })).events, [])
    assert.equal(await readFile(exact, 'utf8'), original + entry('REAL APPEND'))
    const change = (sql: string, ...args: unknown[]) => {
      const db = new Database(dbFile)
      try { db.prepare(sql).run(...args) } finally { db.close() }
    }
    const expectWaiting = (batch: PiLiveBatch) => {
      assert.deepEqual(batch, { id, events: [], skippedRecords: 0, omittedHistory: false, more: false, waiting: true })
    }
    change('DELETE FROM bindings WHERE node_id=?', 'node-fixture')
    expectWaiting(await worker.request('pi-live.read', { id }))
    expectWaiting(await worker.request('pi-live.start', { ...scope, id }))
    change('INSERT INTO bindings VALUES (?,?)', 'node-fixture', session)
    await runner(exact, 'exact', undefined, 'resumed-launch')
    assert.deepEqual((await worker.request('pi-live.read', { id })).events.map(e => e.text), ['EXACT SEAT', 'REAL APPEND'])

    await writeFile(replacement, record('session', { version: 3, id: 'replacement' }) + entry('NEW OCCUPANT'))
    await runner(replacement, 'replacement')
    expectWaiting(await worker.request('pi-live.read', { id })) // The DB still names the old file.
    change('INSERT INTO sessions VALUES (?,?,?,?,?)', 2, 'node-fixture', session, 'pi_session_file', replacement)
    assert.deepEqual((await worker.request('pi-live.read', { id })).events.map(e => e.text), ['NEW OCCUPANT'])
    await runner(replacement, 'replacement', undefined, 'another-launch')
    const rebound = await worker.request('pi-live.read', { id })
    assert.equal(rebound.reset, true); assert.deepEqual(rebound.events.map(e => e.text), ['NEW OCCUPANT'])
    await runner(replacement, 'wrong-header-id')
    await assert.rejects(worker.request('pi-live.read', { id }), /Live Pi stopped/)
    await runner(replacement, 'replacement')
    await worker.request('pi-live.start', { ...scope, id })
    // A different durable node cannot inherit the lease even with the same visible labels.
    for (const table of ['nodes', 'bindings', 'sessions']) change(`UPDATE ${table} SET ${table === 'nodes' ? 'id' : 'node_id'}=?`, 'different-node')
    await assert.rejects(worker.request('pi-live.read', { id }), /Live Pi stopped/)
    assert.deepEqual(await worker.request('pi-live.stop', { id }), { stopped: false })
    const daemonRecord = path.join(home, 'daemon.json'), recordBytes = await readFile(daemonRecord)
    await writeFile(daemonRecord, JSON.stringify({ host: '127.0.0.1', port: 17433, db: path.join(home, 'different.sqlite') }))
    await assert.rejects(worker.request('pi-live.start', { ...scope, id }), /Live Pi stopped/)
    await writeFile(daemonRecord, recordBytes)
    assert.deepEqual((await worker.request('pi-live.start', { ...scope, id })).events.map(e => e.text), ['NEW OCCUPANT'])
    await worker.request('config.save', config)
    await assert.rejects(worker.request('pi-live.read', { id }), /Live Pi stopped/)
    assert.equal(host.callsOf('terminal.sendText').length, 0)
  } finally {
    try { await worker?.deactivate() } finally { await rm(root, { recursive: true, force: true }) }
  }
})
