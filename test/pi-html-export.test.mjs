import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, access, symlink, appendFile, realpath, truncate } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { orcaCommand } from '../src/terminal-receipt.mjs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { queryPiIdentity, validatePiFile } from '../src/pi-session-native.mjs'
import { preparePiExport, copyPiSnapshot, createPiExport, openPiExport, securePiHtml, PI_SESSION_LIMIT } from '../src/pi-html-export.mjs'
import { canExportPiSeat } from '../src/seat-tasks.mjs'
import { configFrom } from '../src/runtime.mjs'
const exec = promisify(execFile)
const hash = value => createHash('sha256').update(value).digest('hex')
const seat = { key: '["rig-1","dev.builder"]', rigId: 'rig-1', rigName: 'demo', logicalId: 'dev.builder', podId: 'pod-1', session: 'dev-builder@demo', runtime: 'pi', status: 'running', activity: 'working' }
const sessionId = '11111111-2222-4333-8444-555555555555'
const content = () => JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: '2026-01-01T00:00:00Z', cwd: '/fixture/project' }) + '\n' + JSON.stringify({ type: 'message', id: 'entry-1', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'Fixture conversation' }], timestamp: 1 } }) + '\n'
function fakeDb(row, generation) {
  return { prepare: sql => sql.includes('sqlite_master') ? { get: () => generation ? { exists: 1 } : undefined } : sql.includes('SELECT successor_generation') ? { get: () => ({ successor_generation: generation }) } : { all: (rig, logical) => { assert.equal(rig, seat.rigId); assert.equal(logical, seat.logicalId); return Array.isArray(row) ? row : [row] } } }
}
async function fixture(generation) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "orca-pi HTML # ' "))), home = path.join(root, 'Native home'), state = path.join(home, 'state', 'pi', ...(generation ? ['account-switches', generation] : []), seat.session), sessions = path.join(state, 'sessions')
  await mkdir(sessions, { recursive: true }); await mkdir(path.join(root, 'plugin data')); await mkdir(path.join(root, 'bin')); await mkdir(path.join(root, 'runtime', 'bin'), { recursive: true })
  const file = path.join(sessions, "exact history # ' .jsonl"), sidecar = path.join(state, 'runner-state.json'), observed = path.join(root, 'export-invocation.json')
  await writeFile(file, content()); await writeFile(sidecar, JSON.stringify({ ready: true, launchId: 'launch-1', sessionId, sessionFile: file, updatedAt: '2026-01-01T00:00:00Z' }))
  await writeFile(path.join(sessions, 'newer-unrelated.jsonl'), content().replaceAll(sessionId, 'unrelated-session'))
  const row = { nodeId: 'node-1', occupantId: 7, rigId: seat.rigId, logicalId: seat.logicalId, podId: seat.podId, runtime: 'pi', session: seat.session, binding: seat.session, resumeType: 'pi_session_file', file }
  const native = await validatePiFile(queryPiIdentity(fakeDb(row, generation), home, seat), home)
  const html = '<!doctype html><html><head><script>var marked={parse:s=>s};</script></head><body><script id="session-data" type="application/json">e30=</script><script>document.body.dataset.fixture=marked.parse("ready")</script></body></html>'
  const pi = path.join(root, 'bin', 'pi')
  await writeFile(pi, `#!/usr/bin/env node\nimport fs from 'node:fs';const a=process.argv.slice(2);if(a[0]!=='--export'||a.length!==3)process.exit(3);fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({args:a,input:fs.readFileSync(a[1],'utf8'),home:process.env.HOME,key:process.env.OPENAI_API_KEY,identity:process.env.OPENRIG_SESSION_NAME}));fs.writeFileSync(a[2],${JSON.stringify(html)});`, { mode: 0o700 })
  await writeFile(path.join(root, 'runtime', 'package.json'), JSON.stringify({ name: '@openrig/cli' })); const rig = path.join(root, 'runtime', 'bin', 'rig.mjs'); await writeFile(rig, '// fixture')
  const config = configFrom({ root: path.join(root, 'plugin data'), extraPath: path.join(root, 'bin'), homePath: root }), snapshot = { tools: { node: process.execPath, rig } }, connection = { source: 'tui', home, port: '17433', key: 'a'.repeat(64) }
  const options = { identity: async () => native, base: { HOME: root, PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'NEVER_FORWARD_FIXTURE', OPENRIG_SESSION_NAME: 'another-seat' } }
  return { root, home, file, sidecar, row, native, observed, pi, html, config, snapshot, connection, options }
}

test('only explicit canonical Native Pi seats are eligible; busy/stopped Pi history remains read-only', () => {
  assert.equal(canExportPiSeat(seat), true); assert.equal(canExportPiSeat({ ...seat, status: 'detached', attention: true }), true)
  for (const patch of [{ runtime: 'claude-code' }, { runtime: 'terminal' }, { session: '' }, { session: 'a@b@remote' }, { rigName: 'kernel' }]) assert.equal(canExportPiSeat({ ...seat, ...patch }), false)
})
test('Native resume metadata selects one exact file, not a newer sibling or cwd match; committed account paths are supported', async () => {
  for (const generation of [undefined, 'account-generation-2']) {
    const f = await fixture(generation)
    try { assert.equal(f.native.file, f.file); assert.equal(f.native.sessionId, sessionId); if (generation) assert.ok(f.native.file.includes('/account-switches/account-generation-2/')) }
    finally { await rm(f.root, { recursive: true, force: true }) }
  }
})
test('a committed account move may explicitly retain the same seat history in an earlier managed directory', async () => {
  const f = await fixture('generation-2')
  try {
    const directory = path.join(f.home, 'state', 'pi', seat.session, 'sessions'); await mkdir(directory, { recursive: true })
    const file = path.join(directory, 'retained.jsonl'); await writeFile(file, content()); await writeFile(f.sidecar, JSON.stringify({ ready: true, launchId: 'launch-2', sessionId, sessionFile: file }))
    const found = await validatePiFile(queryPiIdentity(fakeDb({ ...f.row, file }, 'generation-2'), f.home, seat), f.home)
    assert.equal(found.file, await realpath(file)); assert.ok(found.sidecar.includes('/account-switches/generation-2/'))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('missing, ambiguous, non-Pi, changed runner and personal-file references fail without fallback', async () => {
  const f = await fixture()
  try {
    for (const row of [[], [f.row, f.row], { ...f.row, runtime: 'codex' }, { ...f.row, session: 'other@demo' }, { ...f.row, podId: 'other' }, { ...f.row, file: null }, { ...f.row, resumeType: 'other' }]) assert.throws(() => queryPiIdentity(fakeDb(row), f.home, seat))
    await writeFile(f.sidecar, JSON.stringify({ ready: true, launchId: 'new', sessionId, sessionFile: path.join(path.dirname(f.file), 'newer-unrelated.jsonl') })); await assert.rejects(validatePiFile(queryPiIdentity(fakeDb(f.row), f.home, seat), f.home), /disagree/)
    await writeFile(f.sidecar, JSON.stringify({ ready: false })); await assert.rejects(validatePiFile(queryPiIdentity(fakeDb(f.row), f.home, seat), f.home), /not initialized/)
    const personal = path.join(f.root, 'personal.jsonl'); await writeFile(personal, content()); await assert.rejects(validatePiFile({ ...queryPiIdentity(fakeDb(f.row), f.home, seat), file: personal }, f.home), /outside/)
    await rm(f.file); await assert.rejects(validatePiFile(queryPiIdentity(fakeDb(f.row), f.home, seat), f.home), { code: 'ENOENT' })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('compaction summaries can exceed 16 KiB without weakening Native session binding or removing the read budget', async () => {
  const f = await fixture()
  try {
    const identity = queryPiIdentity(fakeDb(f.row), f.home, seat), summary = 'compacted synthetic context '.repeat(1024)
    const runner = (id, summary) => writeFile(f.sidecar, JSON.stringify({ ready: true, launchId: 'launch-1', sessionId: id, sessionFile: f.file, compaction: { result: { summary } } }))
    await runner(sessionId, summary)
    assert.ok((await stat(f.sidecar)).size > 16 * 1024)
    assert.deepEqual(await validatePiFile(identity, f.home), f.native)
    await runner('different-id', summary)
    await assert.rejects(validatePiFile(identity, f.home), /header does not match/)
    await runner(sessionId, 'x'.repeat(1024 * 1024))
    await assert.rejects(validatePiFile(identity, f.home), /oversized/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('snapshots preserve complete records and the source; concurrent append is excluded and rewrite/truncation fail', async () => {
  const f = await fixture()
  try {
    const before = await readFile(f.file), out = path.join(f.root, 'snapshot.jsonl')
    await appendFile(f.file, '{"partial":'); const copied = await copyPiSnapshot(f.native, out)
    assert.deepEqual(await readFile(out), before); assert.ok(copied.omittedTailBytes > 0)
    await writeFile(f.file, before)
    await copyPiSnapshot(f.native, path.join(f.root, 'append.jsonl'), { betweenReads: () => appendFile(f.file, '{"type":"label"}\n') })
    assert.deepEqual(await readFile(path.join(f.root, 'append.jsonl')), before)
    await writeFile(f.file, before)
    await assert.rejects(copyPiSnapshot(f.native, path.join(f.root, 'rewritten.jsonl'), { betweenReads: () => writeFile(f.file, Buffer.from(before.toString().replace('Fixture', 'Changed'))) }), /rewritten|truncated/)
    await writeFile(f.file, before); await assert.rejects(copyPiSnapshot(f.native, path.join(f.root, 'truncated.jsonl'), { betweenReads: () => writeFile(f.file, '') }), /truncated/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('oversized snapshots are refused before allocation and private export roots cannot escape by symlink', async () => {
  const f = await fixture()
  try {
    await truncate(f.file, PI_SESSION_LIMIT + 1); await assert.rejects(copyPiSnapshot(f.native, path.join(f.root, 'oversized.jsonl')), /snapshot limit/)
    await writeFile(f.file, content())
    const plan = await preparePiExport(f.config, f.snapshot, f.connection, seat, f.options), outside = path.join(f.root, 'outside')
    await mkdir(outside); await symlink(outside, path.join(f.config.root, 'pi-html')); await assert.rejects(createPiExport(plan, f.options), /escaped/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('malformed complete JSONL, wrong session IDs and source inode changes cannot be exported', async () => {
  const f = await fixture()
  try {
    await appendFile(f.file, 'malformed\n'); await assert.rejects(copyPiSnapshot(f.native, path.join(f.root, 'bad.jsonl')), /malformed/)
    await writeFile(f.file, content().replaceAll(sessionId, 'other-id')); await assert.rejects(copyPiSnapshot(f.native, path.join(f.root, 'wrong.jsonl')), /reviewed Native/)
    await rm(f.file); await symlink(path.join(f.root, 'personal'), f.file); await assert.rejects(copyPiSnapshot(f.native, path.join(f.root, 'link.jsonl')))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('supported --export receives only a private snapshot with isolated HOME; paths are literal and the original is unchanged', async () => {
  const f = await fixture()
  try {
    const original = await readFile(f.file), before = await stat(f.file), plan = await preparePiExport(f.config, f.snapshot, f.connection, seat, f.options)
    await assert.rejects(access(plan.directory))
    const receipt = await createPiExport(plan, f.options), observed = JSON.parse(await readFile(f.observed, 'utf8'))
    assert.equal(observed.args[0], '--export'); assert.notEqual(observed.args[1], f.file); assert.equal(observed.input, original.toString()); assert.equal(observed.key, undefined); assert.equal(observed.identity, undefined)
    assert.equal(receipt.browser, 'unverified'); assert.equal(receipt.sessionId, sessionId); assert.ok(receipt.url.includes('%23')); assert.equal((await stat(receipt.file)).mode & 0o777, 0o600)
    assert.deepEqual(await readFile(f.file), original); assert.equal((await stat(f.file)).mtimeMs, before.mtimeMs); await assert.rejects(access(path.join(plan.directory, 'work')))
    const html = await readFile(receipt.file, 'utf8'); assert.ok(html.includes('sandbox="allow-scripts"')); assert.ok(html.includes('connect-src')); assert.ok(html.includes('sha256-')); assert.equal(html.includes('allow-same-origin'), false)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('changed Native occupants/exporters and failed exports leave no view or replacement session', async () => {
  const f = await fixture()
  try {
    const plan = await preparePiExport(f.config, f.snapshot, f.connection, seat, f.options)
    await assert.rejects(createPiExport(plan, { ...f.options, identity: async () => ({ ...f.native, launchId: 'changed' }) }), /changed since review/)
    await assert.rejects(access(plan.directory))
    await assert.rejects(createPiExport(plan, { ...f.options, execute: async () => ({ ok: false }) }), /export failed/)
    await assert.rejects(access(plan.directory)); assert.equal((await readFile(f.file, 'utf8')), content())
    await appendFile(f.pi, '\n// changed'); await assert.rejects(createPiExport(plan, f.options), /exporter changed/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('viewer rejects unsupported/external-script layouts and exposes a sandboxed offline Pi export', async () => {
  const f = await fixture()
  try {
    for (const html of ['not HTML', f.html.replace('var marked', 'var unsupported').replace('marked.parse', 'unsupported.parse'), f.html.replace('<script>', '<script src="https://external.invalid/x.js">')]) assert.throws(() => securePiHtml(html, '/* guard */', 'fixture'))
    const safe = securePiHtml(f.html, '/* guard */', '<img src=x>')
    assert.ok(safe.includes('&lt;img')); assert.ok(safe.includes('frame-src')); assert.ok(safe.includes('no-referrer'))
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
test('optional Native SQLite + installed Pi CLI + Orca browser smoke uses only a synthetic managed seat', async t => {
  if (!process.env.OPENRIG_TEST_RIG || !process.env.OPENRIG_TEST_PI) { t.skip('Set OPENRIG_TEST_RIG and OPENRIG_TEST_PI for the no-agent installed-tool smoke'); return }
  const f = await fixture(); let page
  try {
    let dir = path.dirname(await realpath(process.env.OPENRIG_TEST_RIG)), packageFile
    while (dir !== path.dirname(dir)) { try { const p = path.join(dir, 'package.json'); if (JSON.parse(await readFile(p, 'utf8')).name === '@openrig/cli') { packageFile = p; break } } catch {} dir = path.dirname(dir) }
    assert.ok(packageFile)
    const extra = [
      { type: 'message', id: 'assistant-tool', parentId: 'entry-1', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-fixture', name: 'bash', arguments: { command: 'echo html-export-fixture' } }], api: 'openai-responses', provider: 'fixture', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 2 } },
      { type: 'message', id: 'tool-result', parentId: 'assistant-tool', timestamp: '2026-01-01T00:00:03Z', message: { role: 'toolResult', toolCallId: 'call-fixture', toolName: 'bash', content: [{ type: 'text', text: 'html-export-fixture-tool-output' }], isError: false, timestamp: 3 } }
    ]
    await appendFile(f.file, extra.map(v => JSON.stringify(v)).join('\n') + '\n')
    const original = await readFile(f.file), before = await stat(f.file)
    const seed = `const{createRequire}=require('node:module');const D=createRequire(${JSON.stringify(packageFile)})('better-sqlite3');const db=new D(${JSON.stringify(path.join(f.home, 'openrig.sqlite'))});db.exec(\"CREATE TABLE rigs(id TEXT, archived_at TEXT);CREATE TABLE nodes(id TEXT,rig_id TEXT,logical_id TEXT,pod_id TEXT,runtime TEXT);CREATE TABLE sessions(id INTEGER,node_id TEXT,session_name TEXT,resume_type TEXT,resume_token TEXT);CREATE TABLE bindings(node_id TEXT,tmux_session TEXT);\");db.prepare('INSERT INTO rigs VALUES (?,NULL)').run('rig-1');db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?)').run('node-1','rig-1','dev.builder','pod-1','pi');db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(7,'node-1',${JSON.stringify(seat.session)},'pi_session_file',${JSON.stringify(f.file)});db.prepare('INSERT INTO bindings VALUES (?,?)').run('node-1',${JSON.stringify(seat.session)});db.close()`
    await exec(process.execPath, ['-e', seed])
    await writeFile(path.join(f.home, 'daemon.json'), JSON.stringify({ port: Number(f.connection.port), db: path.join(f.home, 'openrig.sqlite') }))
    const database = await readFile(path.join(f.home, 'openrig.sqlite')), sidecar = await readFile(f.sidecar)
    const config = { ...f.config, extraPath: path.dirname(process.env.OPENRIG_TEST_PI) }, snapshot = { tools: { node: process.execPath, rig: process.env.OPENRIG_TEST_RIG } }
    const plan = await preparePiExport(config, snapshot, f.connection, seat), receipt = await createPiExport(plan)
    assert.deepEqual(await readFile(f.file), original); assert.equal((await stat(f.file)).mtimeMs, before.mtimeMs)
    assert.ok((await readFile(receipt.file, 'utf8')).includes('Pi session snapshot'))
    assert.deepEqual(await readFile(path.join(f.home, 'openrig.sqlite')), database); assert.deepEqual(await readFile(f.sidecar), sidecar)
    if (process.env.OPENRIG_PI_BROWSER_WORKSPACE) {
      const opened = await openPiExport({ ...receipt, workspaceId: process.env.OPENRIG_PI_BROWSER_WORKSPACE }); assert.equal(opened.browser, 'opened', opened.detail); page = opened.browserPageId
      const reused = await openPiExport({ ...receipt, workspaceId: process.env.OPENRIG_PI_BROWSER_WORKSPACE }); assert.equal(reused.browser, 'opened'); assert.equal(reused.browserPageId, page)
      const cli = orcaCommand()
      await exec(cli, ['wait', '--page', page, '--load', 'load', '--json'], { timeout: 20000 })
      const isolation = JSON.parse((await exec(cli, ['eval', '--page', page, '--expression', 'JSON.stringify({bridge:typeof window.orca,node:typeof require,opaque:document.querySelector("iframe").contentDocument===null,url:location.href})', '--json'])).stdout)
      const boundary = JSON.parse(isolation.result.result); assert.equal(boundary.bridge, 'undefined'); assert.equal(boundary.node, 'undefined'); assert.equal(boundary.opaque, true); assert.equal(boundary.url, receipt.url)
      const view = JSON.parse((await exec(cli, ['snapshot', '--page', page, '--json'], { maxBuffer: 2e6 })).stdout)
      if (process.env.OPENRIG_PI_HTML_DEBUG) {
        await writeFile(process.env.OPENRIG_PI_HTML_DEBUG + '-snapshot.json', JSON.stringify(view, null, 2))
        await writeFile(process.env.OPENRIG_PI_HTML_DEBUG + '-console.json', (await exec(cli, ['console', '--page', page, '--json'])).stdout)
        await writeFile(process.env.OPENRIG_PI_HTML_DEBUG + '-export.html', await readFile(receipt.file))
      }
      // The opaque sandbox intentionally hides its DOM from the outer page/AX snapshot.
      assert.ok(JSON.stringify(view).includes('Pi session snapshot'), 'Native browser must expose the sandboxed snapshot frame')
      const shot = JSON.parse((await exec(cli, ['screenshot', '--page', page, '--json'])).stdout)
      assert.ok((await stat(shot.result.path)).size > 1000)
      if (process.env.OPENRIG_PI_HTML_DEBUG) await writeFile(process.env.OPENRIG_PI_HTML_DEBUG + '-shot.json', JSON.stringify(shot, null, 2))
    }
  } finally {
    if (page) await exec(orcaCommand(), ['tab', 'close', '--page', page, '--environment', 'local', '--json'])
    await rm(f.root, { recursive: true, force: true })
  }
})

test('Orca browser uses an encoded file URL/default profile; failed or unknown opens keep the same artifact and reuse an existing tab', async () => {
  const f = await fixture()
  try {
    const plan = await preparePiExport(f.config, f.snapshot, f.connection, seat, f.options), receipt = { ...await createPiExport(plan, f.options), workspaceId: 'identity:fixture-local' }, calls = []
    const execute = async (file, args) => { calls.push({ file, args }); return { ok: true, stdout: JSON.stringify({ ok: true, result: args[1] === 'list' ? { tabs: [] } : { browserPageId: 'fixture-page' } }) } }
    const opened = await openPiExport(receipt, { execute, base: { ORCA_CLI_COMMAND: '/fixture/Orca CLI' } })
    assert.equal(opened.browser, 'opened'); assert.equal(calls[1].file, '/fixture/Orca CLI'); assert.ok(calls[1].args.includes(receipt.url)); assert.ok(calls[1].args.includes('default')); assert.ok(calls[1].args.includes(receipt.workspaceId)); assert.equal(calls.some(c => c.file === 'open'), false)
    const failed = await openPiExport(receipt, { execute: async () => ({ ok: false }) }); assert.equal(failed.browser, 'unverified'); await access(receipt.file)
    const reuse = []; const reopened = await openPiExport(receipt, { execute: async (file, args) => { reuse.push(args); return { ok: true, stdout: JSON.stringify({ ok: true, result: args[1] === 'list' ? { tabs: [{ url: receipt.url, browserPageId: 'existing' }] } : {} }) } } })
    assert.equal(reopened.browserPageId, 'existing'); assert.equal(reuse.some(args => args.includes('create')), false)
    const wrongUrl = await openPiExport({ ...receipt, url: 'https://external.invalid/not-the-export' }, { execute }); assert.equal(wrongUrl.browser, 'unverified'); assert.equal(calls.length, 2)
    await appendFile(receipt.file, 'changed'); const stale = await openPiExport(receipt, { execute }); assert.equal(stale.browser, 'unverified'); assert.equal(calls.length, 2)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
