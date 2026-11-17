import test from 'node:test'
import assert from 'node:assert/strict'
import { mockHost, mountWorker } from 'orca/testing'
import * as workerModule from './worker'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, realpath, symlink, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { configFrom } from './runtime.mjs'
const exec = promisify(execFile)

test('optional loaded-worker success exports an exact synthetic Pi file without terminal input or a live agent', async t => {
  const rig = process.env.OPENRIG_TEST_RIG, pi = process.env.OPENRIG_TEST_PI
  if (!rig || !pi) { t.skip('Explicit installed OpenRig/Pi paths enable the no-agent loaded-worker smoke'); return }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-pi-worker-')))
  let worker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    let directory = path.dirname(await realpath(rig)), packageFile: string | undefined
    while (directory !== path.dirname(directory)) { try { const candidate = path.join(directory, 'package.json'); if (JSON.parse(await readFile(candidate, 'utf8')).name === '@openrig/cli') { packageFile = candidate; break } } catch {} directory = path.dirname(directory) }
    assert.ok(packageFile)
    const sqlite = path.dirname(createRequire(packageFile).resolve('better-sqlite3/package.json')), home = path.join(root, 'Native home'), session = 'dev-worker@fixture', state = path.join(home, 'state', 'pi', session), file = path.join(state, 'sessions', 'exact # history.jsonl'), id = '11111111-2222-4333-8444-555555555555'
    await mkdir(path.dirname(file), { recursive: true }); await mkdir(path.join(root, 'node_modules')); await symlink(sqlite, path.join(root, 'node_modules', 'better-sqlite3'))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@openrig/cli', type: 'module' }))
    const original = JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00Z', cwd: root }) + '\n' + JSON.stringify({ type: 'message', id: 'entry-1', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'Synthetic worker HTML export' }], timestamp: 1 } }) + '\n'
    await writeFile(file, original); await writeFile(path.join(state, 'runner-state.json'), JSON.stringify({ ready: true, launchId: 'launch-fixture', sessionId: id, sessionFile: file, updatedAt: '2026-01-01T00:00:00Z' })); await writeFile(path.join(home, 'daemon.json'), JSON.stringify({ host: '127.0.0.1', port: 17433 }))
    const seed = `const{createRequire}=require('node:module');const D=createRequire(${JSON.stringify(packageFile)})('better-sqlite3');const db=new D(${JSON.stringify(path.join(home, 'openrig.sqlite'))});db.exec("CREATE TABLE rigs(id TEXT,archived_at TEXT);CREATE TABLE nodes(id TEXT,rig_id TEXT,logical_id TEXT,pod_id TEXT,runtime TEXT);CREATE TABLE sessions(id INTEGER,node_id TEXT,session_name TEXT,resume_type TEXT,resume_token TEXT);CREATE TABLE bindings(node_id TEXT,tmux_session TEXT);");db.prepare('INSERT INTO rigs VALUES (?,NULL)').run('rig-fixture');db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?)').run('node-fixture','rig-fixture','dev.worker','pod-fixture','pi');db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(1,'node-fixture',${JSON.stringify(session)},'pi_session_file',${JSON.stringify(file)});db.prepare('INSERT INTO bindings VALUES (?,?)').run('node-fixture',${JSON.stringify(session)});db.close()`
    await exec(process.execPath, ['-e', seed])
    const row = { rigId: 'rig-fixture', rigName: 'fixture', logicalId: 'dev.worker', podId: 'pod-fixture', podNamespace: 'dev', canonicalSessionName: session, runtime: 'pi', sessionStatus: 'running', agentActivity: { state: 'working' } }
    const fakeRig = path.join(root, 'rig.mjs'), tmux = path.join(root, 'tmux')
    await writeFile(fakeRig, `#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='--version')console.log('0.7.13');else if(a[0]==='ps')console.log(${JSON.stringify(JSON.stringify([row]))});else process.exitCode=1`, { mode: 0o700 }); await writeFile(tmux, '#!/bin/sh\nprintf "tmux fixture"', { mode: 0o700 })
    const config = configFrom({ root, instanceHome: home, homePath: root, daemonPort: '17433', nodePath: process.execPath, rigPath: fakeRig, tmuxPath: tmux, extraPath: path.dirname(pi) }), workspace = { id: 'pi-export-mock-workspace-not-a-real-tab', path: root, name: 'Fixture', project: 'Fixture', hostId: 'local', branch: null, kind: 'folder' }
    const host = mockHost({ results: { 'workspace.list': { workspaces: [workspace], truncated: false } }, storage: { 'config.v1': config } })
    worker = await mountWorker(workerModule, { host })
    const inventory = await worker.request('pods.list', { source: 'configured' }), input = { action: 'export-pi-html', workspaceId: workspace.id, exportSource: 'configured' as const, instanceKey: inventory.connection.key, podKey: inventory.pods[0].key, seatKey: inventory.seats[0].key }
    const plan = await worker.request('setup.prepare', input); assert.equal(plan.piExport?.native.file, await realpath(file)); assert.equal(plan.piExport?.native.sessionId, id)
    const result = await worker.request('setup.execute', { planId: plan.id, workspaceId: workspace.id })
    assert.ok('kind' in result && result.kind === 'pi-html')
    if (!('kind' in result)) throw new Error('Expected Pi HTML receipt')
    await readFile(result.file); assert.equal(result.browser, 'unverified') // The mock destination cannot accidentally open a personal browser tab.
    assert.equal(await readFile(file, 'utf8'), original); assert.equal(host.callsOf('terminal.create').length, 0); assert.equal(host.callsOf('terminal.sendText').length, 0)
    await assert.rejects(worker.request('setup.execute', { planId: plan.id, workspaceId: workspace.id }), /Prepare a new plan/)
    const reopened = await worker.request('pi-html.open', { id: result.id }); assert.equal(reopened.file, result.file)
  } finally { await worker?.deactivate(); await rm(root, { recursive: true, force: true }) }
})
