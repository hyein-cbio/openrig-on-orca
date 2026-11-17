#!/usr/bin/env node
// Disposable, real Orca + OpenRig integration smoke test. No model calls or copied logins.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readdir, readFile, realpath, copyFile, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { configFrom, environment, OPENRIG_VERSION, rigInvocation } from '../src/runtime.mjs'
import { stagePlugin } from './stage.mjs'
import { exampleBundle, writeExampleCommand } from '../src/examples.mjs'
import { prepareLaunchReview, stageLaunchProgram } from '../src/launch-review.mjs'
import { optionValue, processSampleState, sandboxConfig, seedFreshOrcaProfile } from './ci-support.mjs'
import { startTopologyPreview } from './preview-topology.mjs'
import { checkTopologyDrilldown } from './topology-browser-checks.mjs'
import { messageRequest } from '../src/seat-tasks.mjs'

const exec = promisify(execFile)
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const root = await mkdtemp(path.join(tmpdir(), 'openrig-for-orca-'))
const stage = path.join(root, 'plugin')
const project = path.join(root, 'project')
const home = path.join(root, 'home')
const cli = process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : process.platform === 'linux' && !process.env.ORCA_WORKSPACE_ID ? 'orca-ide' : 'orca')
const args = new Set(process.argv.slice(2))
const keep = args.has('--keep')
const output = optionValue(process.argv.slice(2), '--output')
const artifactDirectory = output ? path.resolve(output) : root
const env = { ...process.env, ORCA_USER_DATA_PATH: path.join(root, 'orca'), ORCA_BACKGROUND_LAUNCH: '1' }
for (const key of Object.keys(env)) {
  if (key.startsWith('ORCA_RUNTIME_SOURCE_') || ['ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE', 'ORCA_WORKSPACE_ID', 'ORCA_WORKTREE_ID', 'ORCA_TERMINAL_HANDLE', 'ORCA_PANE_KEY', 'ORCA_AGENT_PANE', 'ORCA_TAB_ID'].includes(key)) delete env[key]
}
const report = { root, checks: [], warnings: [], versions: { node: process.version, orca: null, openrig: OPENRIG_VERSION }, exitCode: 1, visual: 'not-captured' }
const check = (id, detail) => report.checks.push({ id, detail })
let fixtureStarted = false, daemonStarted = false, loaded = false, runtimePid, terminalId, rig, rigEnv
let ownedWorkspacePaths = [project]
let rigName
let frozenFixture, previewServer, previewPage, observedPodFixture, browserStep = ''

async function invoke(command, argv, options = {}) {
  return exec(command, argv, { cwd: source, env, timeout: 45000, maxBuffer: 4 * 1024 * 1024, ...options })
}
async function orca(argv, allowFailure = false) {
  let output
  try { output = await invoke(cli, [...argv, '--json']) } catch (error) {
    if (!error.stdout) throw error
    output = { stdout: error.stdout }
  }
  const value = JSON.parse(output.stdout)
  if (!value.ok && !allowFailure) throw new Error(`${value.error?.code}: ${value.error?.message}`)
  return value
}
async function request(name, data) {
  return (await orca(['plugin', 'dev', 'request', stage, name, ...(data === undefined ? [] : ['--data', JSON.stringify(data)])])).result.result
}
async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try { return await check() } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 200)) }
  }
  throw last || new Error('Timed out')
}
async function executePlan(action, workspaceId) {
  const plan = await request('setup.prepare', { action, workspaceId })
  assert.equal(plan.workspaceId, workspaceId)
  const result = await request('setup.execute', { planId: plan.id, workspaceId })
  check(action === 'install-rig' ? 'install-opened' : action === 'start-daemon' ? 'daemon-opened' : action === 'example-demo' ? 'example-opened' : `${action}-opened`, `Confirmed ${action} opens an Orca terminal`)
  return { ...result, plan }
}

console.log(`Sandbox directory: ${root}`)
try {
  await Promise.all([stagePlugin(stage), mkdir(project), mkdir(home), seedFreshOrcaProfile(path.join(root, 'orca'))])
  const install = args.has('--install')
  const rigPath = process.env.OPENRIG_TEST_RIG
  if (!rigPath && !install) throw new Error('Set OPENRIG_TEST_RIG to an existing rig executable, or use --install to test the first-run installer in an Orca terminal')
  // Installation reuses the real npm/1Password environment; no provider/daemon runs until HOME
  // is switched to the isolated home below. Only npm cache and the private prefix are written.
  let config = sandboxConfig(root, { install, rigPath, daemonPort: await availablePort() })
  // Add the fixture's working directory as a folder workspace in the isolated Orca only.
  const opened = await orca(['open'])
  report.versions.orca = opened.result.runtime.appVersion
  const candidatePid = opened.result.app.pid
  const appCommand = (await invoke('ps', ['-p', String(candidatePid), '-o', 'command='])).stdout
  assert.ok(appCommand.includes(path.join(root, 'orca')) || appCommand.includes(await realpath(path.join(root, 'orca'))), 'Refusing to use an Orca process outside the isolated profile')
  runtimePid = candidatePid
  assert.equal(report.versions.orca, '1.4.258', 'The seeded onboarding contract is pinned to Orca 1.4.258')
  await until(async () => {
    const result = await orca(['status'])
    assert.equal(result.result.runtime.state, 'ready')
  })
  await orca(['repo', 'add', '--path', project, '--kind', 'folder'])
  let load = await orca(['plugin', 'dev', 'load', stage], true)
  if (!load.ok && load.error?.code === 'approval_required') {
    const data = load.error.data
    console.log(`Plugin grants: ${data.grants.execution}; ${data.grants.capabilities.map(c => c.kind).join(', ')}`)
    if (!args.has('--approve-plugin')) throw new Error('Review the grants above, then rerun with --approve-plugin to approve only this staged plugin in the isolated Orca')
    assert.equal(data.grants.execution, 'trusted-worker')
    assert.deepEqual(data.grants.capabilities.map(c => c.kind).sort(), ['storage:own', 'terminal:send', 'workspace:read'])
    load = await orca(['plugin', 'dev', 'load', stage, '--approve', data.approvalFingerprint])
  }
  if (!load.ok) throw new Error(load.error.message)
  loaded = true
  let state = await request('config.save', config)
  ownedWorkspacePaths = [...new Set(state.workspaces.map(w => w.path))]
  const target = state.workspaces.find(w => path.resolve(w.path) === path.resolve(project))
  assert.ok(target, 'The sandbox fixture workspace must be selected explicitly')
  if (install) {
    assert.equal(state.snapshot.installed, false)
    await executePlan('install-rig', target.id)
    await until(async () => {
      state = await request('environment.scan')
      assert.equal(state.snapshot.installed, true)
    }, 180000)
    check('first-install', `First-run installer downloaded OpenRig ${OPENRIG_VERSION} in an actual Orca terminal`)
    config = configFrom({ ...config, homePath: home })
    state = await request('config.save', config)
  }
  rig = await rigInvocation(state.snapshot.tools.rig, state.snapshot.tools.node)
  rigEnv = environment(config, env)
  assert.equal(state.snapshot.installed, true, JSON.stringify(state.snapshot.sqlite))
  assert.equal(state.snapshot.ready, false)
  assert.equal(state.snapshot.stage, 'installed-agent-deferred')
  check('runtime-verified', 'Node + tmux + real SQLite verified; installation completes without agent/auth')
  const workspace = state.workspaces.find(w => path.resolve(w.path) === path.resolve(project))
  assert.ok(workspace, 'The sandbox fixture workspace must be selected explicitly')
  await executePlan('start-daemon', workspace.id)
  daemonStarted = true
  await until(async () => { const data = await request('seats.list'); assert.deepEqual(data.seats, []) })
  check('daemon-no-agents', 'Isolated loopback daemon starts with no kernel or agents')
  const consoleReview = await request('setup.prepare', { action: 'console', workspaceId: workspace.id, consoleSource: 'configured' })
  assert.equal(consoleReview.console.port, config.daemonPort); assert.equal(consoleReview.console.source, 'configured'); assert.equal(consoleReview.command.includes('--shared'), false); assert.match(consoleReview.command, /OPENRIG_NO_KERNEL=1/)
  const consoleReceipt = await request('setup.execute', { planId: consoleReview.id, workspaceId: workspace.id }); terminalId = consoleReceipt.terminalId
  await until(async () => { const screen = await orca(['terminal', 'read', '--terminal', terminalId, '--screen']); assert.match(JSON.stringify(screen.result), /(?:No.{0,20}rigs|Topology|For You|Mission Control|Steering)/i) })
  assert.equal((await stat(consoleReview.consoleRuntime)).isDirectory(), true)
  assert.deepEqual((await request('seats.list')).seats, [], 'Opening the TUI must not create kernel or agent registrations')
  await orca(['terminal', 'close', '--terminal', terminalId]); terminalId = null
  await until(async () => assert.rejects(stat(consoleReview.consoleRuntime), { code: 'ENOENT' }))
  assert.equal((await request('environment.scan')).daemon.status, 'reachable', 'Closing the TUI must preserve the daemon')
  check('tui-console', 'The reviewed configured CLI opened a real standalone rig tui in an Orca PTY for an empty no-kernel instance; opening/closing it created no seats and left the daemon running')
  const demo = await executePlan('example-demo', workspace.id)
  rigName = demo.plan.example.rigName
  fixtureStarted = true
  const demoSeats = await until(async () => {
    const data = await request('seats.list')
    const found = data.seats.filter(s => s.rigName === rigName && s.status === 'running')
    assert.equal(found.length, 2)
    return found
  })
  check('two-seats', 'Plugin-created Builder and Reviewer terminal seats are running')
  const inventory = await request('pods.list', { source: 'configured' })
  const observedPod = inventory.pods.find(p => p.rigId === demoSeats[0].rigId && p.namespace === 'dev')
  assert.ok(observedPod); assert.equal(observedPod.seatCount, 2); assert.equal(inventory.connection.matchesConfigured, true)
  const relations = await request('pods.edges', { source: 'configured', instanceKey: inventory.connection.key, podKey: observedPod.key })
  assert.equal(relations.status, 'complete'); assert.equal(relations.edges.length, 1); assert.equal(relations.edges[0].kind, 'delegates_to')
  check('native-relationships', 'Compact read-only native whoami observations resolve the terminal demo relationship without full graph, token or transcript requests')
  const reportBody = 'TOOLTIP_BODY_FIXTURE <script>window.tooltipInjected=true</script>\n' + '\uAC00🙂'.repeat(300)
  const audit = await fetch(`http://127.0.0.1:${config.daemonPort}/api/queue/outbox/record`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outboxId: `tooltip-fixture-${randomUUID()}`, senderSession: demoSeats[0].session, destinationSession: demoSeats[1].session, body: reportBody, tags: ['tooltip-fixture'] }) })
  assert.equal(audit.status, 201, 'Task-owned outbox audit fixture must record without sending terminal input')
  const reportPreview = await request('seat.report', { source: 'configured', instanceKey: inventory.connection.key, podKey: observedPod.key, seatKey: demoSeats[0].key })
  assert.equal(reportPreview.status, 'recorded'); assert.equal(reportPreview.truncated, true); assert.ok(reportPreview.previewBytes <= 500); assert.equal(Buffer.byteLength(reportPreview.preview), reportPreview.previewBytes)
  // Seed completed request evidence only in this proven task-owned SQLite instance. No queue
  // create/nudge or agent input is needed to test the read-only result-report projection.
  const dbPath = await realpath(path.join(config.root, 'instance', 'openrig.sqlite'))
  assert.ok(dbPath.startsWith((await realpath(root)) + path.sep), 'Refusing report fixtures outside the private test root')
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(dbPath)
  const userResult = 'RESULT_BODY_FIXTURE <script>window.reportInjected=true</script>\nFinal total: 500500. Independent check recorded.\n' + '\uAC00🙂'.repeat(2800), reportId = `qitem-report-fixture-${randomUUID()}`
  try {
    db.exec('PRAGMA busy_timeout=2000')
    const insert = db.prepare('INSERT INTO queue_items (qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,body,summary,resolution,closure_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)'), stamp = new Date().toISOString()
    insert.run(reportId, stamp, stamp, 'user@external', demoSeats[0].session, 'done', 'routine', 'Original user calculation request', 'User requested calculation and independent review', userResult, 'no-follow-on')
    insert.run(`qitem-peer-fixture-${randomUUID()}`, stamp, stamp, demoSeats[1].session, demoSeats[0].session, 'done', 'routine', 'Internal peer handoff', 'Peer task, not a user report', 'INTERNAL_RESOLUTION_FIXTURE', 'no-follow-on')
  } finally { db.close() }
  const userReports = await request('user.reports', { source: 'configured', instanceKey: inventory.connection.key, podKey: observedPod.key, seatKey: demoSeats[0].key, sources: ['user@external', 'orca-gui@external'] })
  assert.equal(userReports.status, 'ready'); assert.equal(userReports.reports.length, 1); assert.equal(userReports.reports[0].id, reportId); assert.equal(userReports.reports[0].truncated, true); assert.ok(userReports.reports[0].bodyBytes <= 16384)
  assert.equal(JSON.stringify(userReports).includes('INTERNAL_RESOLUTION_FIXTURE'), false)
  observedPodFixture = { pod: observedPod, seats: inventory.seats.filter(s => s.rigId === observedPod.rigId && s.podId === observedPod.podId), observedAt: inventory.observedAt, relations, reportPreview, userReports }
  check('pod-inventory', 'Real CLI projected rig/pod identities for both terminal-only seats from the explicitly configured private instance')
  for (const seat of demoSeats) {
    const attached = await request('seat.attach', { key: seat.key, workspaceId: workspace.id, readOnly: true })
    terminalId = attached.terminalId
    await until(async () => {
      const screen = await orca(['terminal', 'read', '--terminal', terminalId, '--screen'])
      assert.match(JSON.stringify(screen.result), /SIMULATION ONLY/)
    })
    await orca(['terminal', 'close', '--terminal', terminalId])
    terminalId = null
    assert.equal((await request('seats.list')).seats.find(s => s.key === seat.key)?.status, 'running')
  }
  check('seat-attached', 'Both example roles rendered prerecorded simulation output in actual Orca PTYs')
  check('detach-preserves-seat', 'Closing Orca views leaves both tmux seats running')
  const stop = await request('setup.prepare', { action: 'stop-example', workspaceId: workspace.id, exampleId: demo.plan.example.id })
  await request('setup.execute', { planId: stop.id, workspaceId: workspace.id })
  await until(async () => {
    const data = await request('seats.list')
    assert.equal(data.seats.filter(s => s.rigName === rigName && s.status === 'running').length, 0)
  })
  fixtureStarted = false
  check('example-stopped', 'Explicit plugin stop action stops only the recorded terminal demo')
  for (const provider of ['claude', 'codex']) {
    const template = await executePlan(`example-${provider}`, workspace.id)
    const directory = template.plan.example.directory
    await until(async () => { await readFile(path.join(directory, 'agents', 'reviewer', 'role.md'), 'utf8') })
    await invoke(rig.file, [...rig.args, 'spec', 'validate', template.plan.example.specPath, '--json'], { env: rigEnv })
    for (const role of ['builder', 'reviewer']) await invoke(rig.file, [...rig.args, 'agent', 'validate', path.join(directory, 'agents', role, 'agent.yaml')], { env: rigEnv })
    assert.equal((await request('seats.list')).seats.some(s => s.rigName === template.plan.example.rigName), false)
    const review = await prepareLaunchReview(template.plan.example.specPath, path.join(directory, 'project'), { ...config, provider }, state.snapshot, { baseEnv: env })
    assert.equal(review.display.seats.length, 2)
    assert.ok(review.display.seats.every(seat => seat.runtime === (provider === 'claude' ? 'claude-code' : 'codex')))
    assert.ok(review.display.unverified.length)
    const rolePath = path.join(directory, 'agents', 'builder', 'role.md')
    const original = await readFile(rolePath, 'utf8')
    await writeFile(rolePath, original + '\nChanged after review; must not change the archive.\n')
    const inspected = JSON.parse(await invoke(rig.file, [...rig.args, 'bundle', 'inspect', review.archive, '--json'], { env: rigEnv }).then(result => result.stdout))
    assert.equal(inspected.archiveHash, review.hash)
    assert.equal(inspected.integrityResult.passed, true)
    await writeFile(rolePath, original)
  }
  check('frozen-launch-review', 'Real OpenRig froze both provider templates and displayed declarations/unknowns independently of mutable source files')
  check('templates-validated', 'Both single-provider RigSpecs and all AgentSpecs validated by real OpenRig; no real agent seats launched')
  const frozen = exampleBundle('demo', randomUUID().replaceAll('-', '').slice(0, 12), path.join(root, 'frozen-fixture'))
  await invoke('/bin/sh', ['-c', writeExampleCommand(process.execPath, frozen)])
  const frozenReview = await prepareLaunchReview(frozen.specPath, frozen.project, config, state.snapshot, { baseEnv: env })
  await stageLaunchProgram(frozenReview)
  frozenFixture = frozen.rigName
  const frozenOutput = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [frozenReview.programPath], { env: rigEnv, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error) })
    child.stdin.end('ACCEPT UNVERIFIED SETTINGS\nLAUNCH\n')
  })
  assert.match(frozenOutput, /FROZEN LAUNCH REVIEW/)
  await until(async () => assert.equal((await request('seats.list')).seats.filter(seat => seat.rigName === frozenFixture && seat.status === 'running').length, 2))
  await invoke(rig.file, [...rig.args, 'down', frozenFixture], { env: rigEnv }); frozenFixture = undefined
  check('frozen-terminal-launch', 'The frozen-bundle confirmation program previewed and launched two real terminal-only seats; no model runtime was used')
  const registered = (await orca(['plugin', 'list'])).result.plugins.find(p => p.pluginKey === 'local.openrig-for-orca')
  assert.deepEqual(registered.panels.map(p => p.id), ['openrig'])
  const preview = await startTopologyPreview(); previewServer = preview.server
  previewPage = (await orca(['tab', 'create', '--worktree', `path:${project}`, '--url', preview.url])).result.browserPageId
  const evaluate = async expression => JSON.parse((await orca(['eval', '--page', previewPage, '--expression', expression])).result.result)
  await orca(['viewport', '--page', previewPage, '--width', '1200', '--height', '1200'])
  await until(async () => assert.equal(await evaluate('JSON.stringify(document.querySelectorAll(\'[role="tab"]\').length)'), 3))
  await evaluate('JSON.stringify(document.getElementById("view-dashboard").click() || true)')
  assert.equal(await evaluate('JSON.stringify(document.querySelectorAll("#diagram svg").length)'), 0)
  assert.equal(await evaluate('JSON.stringify(document.getElementById("workspace-destination-control").parentElement.id)'), 'dashboard-destination')
  browserStep = 'topology-drilldown'
  await checkTopologyDrilldown(evaluate, until)
  check('topology-drilldown', 'Synthetic hub overview, nested mouse/keyboard drill-down, measured top-root geometry, history/camera, refresh/reorder, scoped SVG export, missing roots, instance changes and YAML edit guards')
  await evaluate(`(async()=>{const m=await import('/visualizer/app.mjs');m.displayPodSnapshot(${JSON.stringify(observedPodFixture.pod)},${JSON.stringify(observedPodFixture.seats)},${observedPodFixture.observedAt},${JSON.stringify(observedPodFixture.relations)});return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate('JSON.stringify(document.getElementById("edge-count").textContent)'), '1'))
  assert.equal(await evaluate('JSON.stringify([...document.querySelectorAll("#diagram path.flowchart-link")].filter(p=>parseFloat(getComputedStyle(p).strokeWidth)>0 && p.hasAttribute("marker-end")).length)'), 1)
  await evaluate(`(async()=>{const m=await import('/visualizer/app.mjs');m.displayPodSnapshot(${JSON.stringify(observedPodFixture.pod)},${JSON.stringify(observedPodFixture.seats)},${observedPodFixture.observedAt});return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate('JSON.stringify(document.getElementById("edge-count").textContent)'), '—'))
  await until(async () => assert.equal(await evaluate('JSON.stringify(document.querySelectorAll("#diagram g.node[role=button]").length)'), 2))
  assert.equal(await evaluate('JSON.stringify(!document.getElementById("dashboard-view").hidden && document.getElementById("preparation-view").hidden)'), true)
  await until(async () => assert.ok(await evaluate('JSON.stringify(document.querySelector("#diagram svg").getBoundingClientRect().width > 100)')))
  const nodeCenters = async () => evaluate('JSON.stringify([...document.querySelectorAll("#diagram g.node[role=button]")].map(n=>{const r=n.getBoundingClientRect();return {id:n.id,x:r.x+r.width/2,y:r.y+r.height/2}}).sort((a,b)=>Number(a.id.match(/agent_(\\d+)/)[1])-Number(b.id.match(/agent_(\\d+)/)[1])))')
  for (const direction of ['LR', 'TB']) {
    await evaluate(`(()=>{const d=document.getElementById('direction');d.value=${JSON.stringify(direction)};d.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify(true)})()`)
    await until(async () => {
      assert.equal(await evaluate(`JSON.stringify(document.getElementById('mermaid-source').value.startsWith('flowchart ${direction}'))`), true)
      const centers = await nodeCenters(); assert.equal(centers.length, 2)
      const dx = centers[1].x - centers[0].x, dy = centers[1].y - centers[0].y
      assert.ok(direction === 'LR' ? dx > 20 && Math.abs(dy) < 2 : dy > 20 && Math.abs(dx) < 2, `Expected ${direction} node order; observed dx=${dx.toFixed(1)}, dy=${dy.toFixed(1)}`)
    })
  }
  check('topology-layout', 'Disconnected inventory seats render in actual left-to-right and top-to-bottom coordinate order, not merely matching dropdown values')
  await evaluate(`(async()=>{const m=await import('/visualizer/app.mjs');m.displayPodSnapshot(${JSON.stringify(observedPodFixture.pod)},${JSON.stringify(observedPodFixture.seats)},${observedPodFixture.observedAt},${JSON.stringify(observedPodFixture.relations)});return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate('JSON.stringify(document.getElementById("edge-count").textContent)'), '1'))
  browserStep = 'hover-preview'
  const hoverKey = observedPodFixture.reportPreview.seatKey
  const hoverName = observedPodFixture.seats.find(s => s.key === hoverKey).logicalId
  const hoverNode = `[...document.querySelectorAll('#diagram [role=button]')].find(e=>e.getAttribute('aria-label')===${JSON.stringify('Inspect ' + hoverName)})`
  await evaluate(`(async()=>{const m=await import('/visualizer/app.mjs');m.setReportReader(async key=>key===${JSON.stringify(hoverKey)}?${JSON.stringify(observedPodFixture.reportPreview)}:{status:'none',detail:'Fixture: no record'});${hoverNode}.scrollIntoView({block:'center'});${hoverNode}.dispatchEvent(new MouseEvent('mouseenter'));return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(document.querySelector('#seat-report-tooltip pre')?.textContent===${JSON.stringify(observedPodFixture.reportPreview.preview)})`), true))
  await evaluate(`(()=>{document.getElementById('zoom-in').click();window.refreshSvg=document.querySelector('#diagram svg');window.refreshNode=${hoverNode};window.refreshWidth=window.refreshSvg.style.width;window.refreshSelected=document.getElementById('agent-name').textContent;return JSON.stringify(true)})()`)
  await evaluate(`(async()=>{const m=await import('/visualizer/app.mjs');m.displayPodSnapshot(${JSON.stringify(observedPodFixture.pod)},${JSON.stringify(observedPodFixture.seats)},${observedPodFixture.observedAt + 60000},${JSON.stringify({ ...observedPodFixture.relations, observedAt: observedPodFixture.observedAt + 60000 })},{seatsStale:false,relationsStale:false});return JSON.stringify(true)})()`)
  assert.equal(await evaluate(`JSON.stringify(window.refreshSvg===document.querySelector('#diagram svg') && window.refreshNode===${hoverNode} && window.refreshWidth===window.refreshSvg.style.width && window.refreshSelected===document.getElementById('agent-name').textContent && !document.getElementById('seat-report-tooltip').hidden)`), true)
  await evaluate(`(async()=>{const m=await import('/visualizer/app.mjs');m.updateObservationFreshness({seatsStale:true,relationsStale:true});return JSON.stringify(true)})()`)
  assert.equal(await evaluate('JSON.stringify(document.getElementById("topology-origin").textContent.includes("Stale") && window.refreshSvg===document.querySelector("#diagram svg"))'), true)
  check('refresh-render-stability', 'An unchanged observation preserves SVG/node identity, zoom, selection and an open tooltip; stale markers update without redrawing')
  browserStep = 'inert-html'
  assert.equal(await evaluate('JSON.stringify(document.querySelector("#seat-report-tooltip script")===null && window.tooltipInjected!==true)'), true)
  assert.equal(await evaluate('JSON.stringify(document.querySelector("#diagram svg").outerHTML.includes("TOOLTIP_BODY_FIXTURE"))'), false)
  assert.equal(await evaluate(`JSON.stringify(${hoverNode}.getAttribute('aria-describedby'))`), 'seat-report-tooltip')
  browserStep = 'mouseleave'
  await evaluate(`JSON.stringify(${hoverNode}.dispatchEvent(new MouseEvent('mouseleave')))`)
  assert.equal(await evaluate('JSON.stringify(document.getElementById("seat-report-tooltip").hidden)'), true)
  browserStep = 'keyboard-preview'
  // Background Chromium can update activeElement without a focus event. Exercise the renderer's
  // focus handler explicitly rather than fronting the app or taking the user's keyboard focus.
  await evaluate(`(()=>{const node=${hoverNode};node.scrollIntoView({block:'center'});node.focus();node.dispatchEvent(new FocusEvent('focus'));return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(document.querySelector('#seat-report-tooltip pre')?.textContent===${JSON.stringify(observedPodFixture.reportPreview.preview)})`), true))
  browserStep = 'escape'
  await evaluate(`JSON.stringify(${hoverNode}.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})))`)
  assert.equal(await evaluate('JSON.stringify(document.getElementById("seat-report-tooltip").hidden)'), true)
  browserStep = 'selected-tooltip-dismissal'
  const dismissals = await evaluate(`(async()=>{
    const node=${hoverNode},m=await import('/visualizer/app.mjs'),record=${JSON.stringify(observedPodFixture.reportPreview)};
    const flush=async()=>{await Promise.resolve();await Promise.resolve()};
    node.dispatchEvent(new FocusEvent('focus'));await flush();node.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    const clickCloses=document.getElementById('seat-report-tooltip').hidden&&document.getElementById('agent-name').textContent===${JSON.stringify(hoverName)};
    node.focus();node.dispatchEvent(new FocusEvent('focus'));await flush();node.dispatchEvent(new MouseEvent('mouseleave'));
    const leaveWhileFocused=document.activeElement===node&&document.getElementById('seat-report-tooltip').hidden&&!node.hasAttribute('aria-describedby');
    let keyboardCloses=true;for(const key of ['Enter',' ']){node.dispatchEvent(new FocusEvent('focus'));await flush();node.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));keyboardCloses=keyboardCloses&&document.getElementById('seat-report-tooltip').hidden;}
    let finish;m.setReportReader(()=>new Promise(resolve=>{finish=resolve}));node.dispatchEvent(new MouseEvent('mouseenter'));node.dispatchEvent(new MouseEvent('click',{bubbles:true}));finish(record);await flush();
    const lateIgnored=document.getElementById('seat-report-tooltip').hidden&&!document.querySelector('#seat-report-tooltip pre');m.setReportReader(async()=>record);
    return JSON.stringify({clickCloses,leaveWhileFocused,keyboardCloses,lateIgnored});
  })()`)
  assert.deepEqual(dismissals, { clickCloses: true, leaveWhileFocused: true, keyboardCloses: true, lateIgnored: true })
  check('report-tooltip', 'Native UTF-8 hover/focus previews remain inert and outside SVG; click/Enter/Space and mouseleave (even while focused) dismiss immediately, and late reads cannot reopen them')
  browserStep = 'user-report-cards'
  await evaluate(`(async()=>{const m=await import('/visualizer/workspace.mjs');m.displayUserReportSnapshot(${JSON.stringify(observedPodFixture.userReports)});return JSON.stringify(true)})()`)
  assert.equal(await evaluate('JSON.stringify(document.querySelectorAll("#user-report-list article").length)'), 1)
  assert.equal(await evaluate('JSON.stringify(document.querySelector("#user-report-list script")===null && window.reportInjected!==true)'), true)
  assert.equal(await evaluate(`JSON.stringify(document.querySelector('#user-report-list pre').textContent===${JSON.stringify(observedPodFixture.userReports.reports[0].body)})`), true)
  assert.equal(await evaluate('JSON.stringify(document.querySelector("#diagram svg").outerHTML.includes("RESULT_BODY_FIXTURE"))'), false)
  await evaluate('JSON.stringify(document.querySelector("#user-report-list details").open=true)')
  await evaluate(`(async()=>{const m=await import('/visualizer/workspace.mjs');m.displayUserReportSnapshot(${JSON.stringify({ ...observedPodFixture.userReports, status: 'partial' })},'Read failed: older report snapshot');return JSON.stringify(true)})()`)
  assert.equal(await evaluate('JSON.stringify(!document.getElementById("user-report-error").hidden && document.getElementById("user-report-status").textContent.includes("older retained snapshot"))'), true)
  check('user-report-cards', 'Private native external-request resolutions render as inert bounded report cards with source IDs, plain original text, expansion and stale/error labels; peer tasks and SVG exports contain no report body')
  browserStep = 'user-report-controls'
  // A separate realm runs the shipped controller and actual DOM handlers, without
  // replacing the personal plugin or forwarding a mutation through the test bridge; message receipts are simulated.
  const controlEnvironment = await request('environment.scan')
  const messageId = `qitem-orca-${'f'.repeat(32)}`, requestFixture = { id: messageId, ...messageRequest('Fixture-only message; never send', messageId) }
  const piExportId = 'c'.repeat(32), piReceipt = { kind: 'pi-html', id: piExportId, workspaceId: workspace.id, file: '/fixture/pi-html/report.html', session: observedPodFixture.seats[0].session, sessionId: 'pi-session-fixture', snapshotAt: Date.now(), bytes: 2000, omittedTailBytes: 0, browser: 'unverified', detail: 'Fixture HTML exported; no Native session was read' }
  const piPlan = { id: 'pi-html-controls-fixture', action: 'export-pi-html', workspaceId: workspace.id, title: 'Review Pi HTML fixture', command: 'Fixture export only', source: 'https://pi.dev', writes: ['/fixture/pi-html'], warnings: [], piExport: { target: { session: piReceipt.session }, native: { file: '/fixture/Native Pi history #.jsonl', sessionId: piReceipt.sessionId }, exporter: { path: '/fixture/Pi CLI' }, directory: '/fixture/pi-html' } }
  const controlHtml = (await readFile(path.join(stage, 'src/visualizer/plugin.html'), 'utf8')).replace(/(src|href)="([^"]+)"/g, (_, attribute, value) => `${attribute}="${new URL(value, new URL('/visualizer/plugin.html', preview.url)).href}"`)
  await evaluate(`(()=>{
    const frame=document.createElement('iframe');frame.id='report-controls-fixture';frame.style.cssText='position:fixed;top:10px;left:10px;width:900px;height:900px;z-index:2000;background:white';document.body.append(frame);const d=frame.contentDocument;d.open();
    const catalog=${JSON.stringify(inventory)},reports=${JSON.stringify(observedPodFixture.userReports)},relations=${JSON.stringify(relations)},environment=${JSON.stringify(controlEnvironment)},consolePlan=${JSON.stringify(consoleReview)};catalog.connection.source='tui';
    window.reportControlProbe={calls:[],fail:false};const probe=window.reportControlProbe;
    frame.contentWindow.orca={plugin:{request:async(name,input)=>{probe.calls.push({name,input});if(name==='environment.scan')return environment;if(name==='examples.list')return {examples:[]};if(name==='pods.list')return {...catalog,seats:probe.startFixture?catalog.seats.map(s=>({...s,runtime:s.key===probe.startSeatKey?'pi':'modal-pi-middle',status:probe.messageFixture&&s.key===probe.startSeatKey?'running':'detached',lifecycle:probe.messageFixture&&s.key===probe.startSeatKey?'running':'detached',activity:probe.messageFixture&&s.key===probe.startSeatKey?'idle':'unknown',attention:false})):catalog.seats,connection:{...catalog.connection,source:input.source,matchesConfigured:probe.startFixture?probe.routingMatches:catalog.connection.matchesConfigured}};if(name==='pods.edges')return relations;if(name==='seat.report')return {status:'none',detail:'Read-only fixture'};if(name==='setup.prepare'&&input.action==='export-pi-html')return {...${JSON.stringify(piPlan)},expires:Date.now()+60000,workspaceId:input.workspaceId};if(name==='setup.execute'&&input.planId==='pi-html-controls-fixture')return ${JSON.stringify(piReceipt)};if(name==='pi-html.open'&&input.id===${JSON.stringify('c'.repeat(32))})return {...${JSON.stringify(piReceipt)},browser:'opened',browserPageId:'fixture-browser'};if(name==='setup.prepare'&&input.action==='send-message'){const seat=catalog.seats.find(s=>s.key===input.seatKey);return {id:'message-controls-fixture',action:'send-message',expires:Date.now()+60000,workspaceId:input.workspaceId,title:'Review fixture message',command:'Fixture review only; never send',source:'https://openrig.dev',writes:[],warnings:['Sending can invoke a model'],instruction:{key:seat.key,session:seat.session,runtime:'pi',text:input.message,completion:${JSON.stringify(requestFixture.completion)}},queueTask:{...${JSON.stringify(requestFixture)},destination:seat.session,key:seat.key,runtime:'pi',bodyFile:'/fixture/body.txt'}};}if(name==='setup.execute'&&input.planId==='message-controls-fixture')return {terminalId:'term_message_fixture',task:{id:${JSON.stringify(messageId)},destination:catalog.seats.find(s=>s.key===probe.startSeatKey).session,registration:'unverified',state:'unknown',detail:'Fixture-only request receipt'}};if(name==='task.check'&&input.id===${JSON.stringify(messageId)}){const body='Stored fixture answer <img src=x onerror=alert(1)>',bytes=new TextEncoder().encode(body).length;return {id:input.id,destination:catalog.seats.find(s=>s.key===probe.startSeatKey).session,registration:'verified',state:'done',detail:'Fixture stored result',resolution:{body,bytes,totalBytes:bytes,truncated:false}};}if(name==='setup.prepare'&&input.action==='launch-seat'){const seat=catalog.seats.find(s=>s.key===input.seatKey);if(!seat)throw Error('Unknown fixture seat');return {id:'seat-start-controls-fixture',action:'launch-seat',expires:Date.now()+60000,workspaceId:input.workspaceId,title:'Start selected fixture seat',command:'Fixture review only; no execution',source:'https://openrig.dev',writes:[],warnings:['Agent startup may invoke models'],seatLaunch:{...seat,runtime:'pi',status:'detached',lifecycle:'detached'}};}if(name==='setup.prepare'&&input.action==='console')return {...consolePlan,id:'tui-controls-fixture',expires:Date.now()+60000,workspaceId:input.workspaceId,console:{...consolePlan.console,source:input.consoleSource||'configured'}};if(name==='user.reports')return probe.fail?{...reports,status:'unverified',reports:[]}:reports;throw Error('No mutation is available in the fixture bridge');}}};
    d.write(${JSON.stringify(controlHtml)});d.close();return JSON.stringify(true);
  })()`)
  const controlDoc = `document.getElementById('report-controls-fixture').contentDocument`
  await until(async () => assert.equal(await evaluate(`JSON.stringify(${controlDoc}.getElementById('scan-environment')?.disabled===false && ${controlDoc}.getElementById('dashboard-pod')?.options.length>1)`), true))
  await evaluate(`(()=>{const d=${controlDoc};d.getElementById('view-dashboard').click();const pod=d.getElementById('dashboard-pod');pod.value=${JSON.stringify(observedPodFixture.pod.key)};pod.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(${controlDoc}.getElementById('reporting-seat').options.length>1 && !${controlDoc}.getElementById('refresh-pods').disabled)`), true))
  assert.equal(await evaluate(`JSON.stringify(window.reportControlProbe.calls.filter(c=>c.name==='user.reports').length)`), 0)
  await evaluate(`(()=>{const d=${controlDoc},seat=d.getElementById('reporting-seat');seat.value=${JSON.stringify(observedPodFixture.userReports.seatKey)};seat.dispatchEvent(new Event('change',{bubbles:true}));d.getElementById('load-user-reports').click();return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(${controlDoc}.querySelectorAll('#user-report-list article').length)`), 1))
  assert.deepEqual(await evaluate(`JSON.stringify(window.reportControlProbe.calls.find(c=>c.name==='user.reports').input)`), { source: 'tui', instanceKey: inventory.connection.key, podKey: observedPodFixture.pod.key, seatKey: observedPodFixture.userReports.seatKey, sources: ['user@external', 'orca-gui@external'] })
  await evaluate(`(()=>{const d=${controlDoc};d.querySelector('#user-report-list summary').click();window.reportControlProbe.body=d.querySelector('#user-report-list pre');d.getElementById('refresh-pods').click();return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(!${controlDoc}.getElementById('refresh-pods').disabled)`), true))
  assert.equal(await evaluate(`JSON.stringify(${controlDoc}.querySelector('#user-report-list pre')===window.reportControlProbe.body && ${controlDoc}.querySelector('#user-report-list details').open && window.reportControlProbe.calls.filter(c=>c.name==='user.reports').length===1)`), true)
  await evaluate(`(()=>{const frame=document.getElementById('report-controls-fixture');frame.style.width='274px';frame.contentDocument.documentElement.classList.remove('light');frame.contentDocument.documentElement.classList.add('dark');return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(${controlDoc}.documentElement.clientWidth<=274 && ${controlDoc}.documentElement.scrollWidth<=${controlDoc}.documentElement.clientWidth+1 && ${controlDoc}.querySelector('#user-report-list details').open)`), true))
  await evaluate(`JSON.stringify((window.reportControlProbe.fail=true,${controlDoc}.getElementById('load-user-reports').click(),true))`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(!${controlDoc}.getElementById('user-report-error').hidden && ${controlDoc}.getElementById('user-report-status').textContent.includes('older retained snapshot'))`), true))
  assert.equal(await evaluate(`JSON.stringify(${controlDoc}.querySelector('#user-report-list pre')===window.reportControlProbe.body && ${controlDoc}.querySelector('#user-report-list details').open)`), true)
  await evaluate(`(()=>{const d=${controlDoc},input=d.getElementById('user-report-sources');input.value='peer@fixture';input.dispatchEvent(new Event('input',{bubbles:true}));d.getElementById('load-user-reports').click();return JSON.stringify(true)})()`)
  assert.equal(await evaluate(`JSON.stringify(${controlDoc}.querySelectorAll('#user-report-list pre').length===0 && window.reportControlProbe.calls.filter(c=>c.name==='user.reports').length===2 && window.reportControlProbe.calls.every(c=>['environment.scan','examples.list','pods.list','pods.edges','user.reports','seat.report'].includes(c.name)))`), true)
  await evaluate(`(()=>{const d=${controlDoc};d.getElementById('view-preparation').click();const workspace=d.getElementById('plugin-workspace');workspace.value=${JSON.stringify(workspace.id)};workspace.dispatchEvent(new Event('change',{bubbles:true}));d.querySelector('[data-operation="console"]').click();return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(!${controlDoc}.getElementById('plugin-review').hidden && ${controlDoc}.getElementById('review-target').textContent.includes(${JSON.stringify(consoleReview.console.home)}))`), true))
  await evaluate(`(()=>{const d=${controlDoc};d.getElementById('cancel-operation').click();d.getElementById('go-dashboard').click();return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(${controlDoc}.getElementById('pod-instance-source').value==='configured' && !${controlDoc}.getElementById('open-observed-tui').disabled && ${controlDoc}.getElementById('dashboard-pod').value==='')`), true))
  await evaluate(`JSON.stringify((${controlDoc}.getElementById('open-observed-tui').click(),true))`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(!${controlDoc}.getElementById('plugin-review').hidden)`), true))
  assert.deepEqual(await evaluate(`JSON.stringify((()=>{const c=window.reportControlProbe.calls.filter(c=>c.name==='setup.prepare').at(-1);return {source:c.input.consoleSource,key:c.input.instanceKey,workspaceId:c.input.workspaceId,executed:window.reportControlProbe.calls.some(c=>c.name==='setup.execute'||c.name==='config.save')};})())`), { source: 'configured', key: inventory.connection.key, workspaceId: workspace.id, executed: false })
  check('tui-controls', 'Prominent configured/observed TUI buttons prepare exact instance-bound reviews; configured Dashboard handoff changes observations only and TUI review works without a selected pod or automatic execution')
  await evaluate(`(()=>{const d=${controlDoc};d.getElementById('cancel-operation').click();window.reportControlProbe.startFixture=true;window.reportControlProbe.routingMatches=false;window.reportControlProbe.startSeatKey=${JSON.stringify(observedPodFixture.seats[0].key)};const workspace=d.getElementById('plugin-workspace');workspace.value='';workspace.dispatchEvent(new Event('change',{bubbles:true}));d.getElementById('refresh-pods').click();return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(!${controlDoc}.getElementById('refresh-pods').disabled)`), true))
  await evaluate(`(()=>{const d=${controlDoc},pod=d.getElementById('dashboard-pod');pod.value=${JSON.stringify(observedPodFixture.pod.key)};pod.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(!${controlDoc}.getElementById('pod-start-controls').hidden && !${controlDoc}.getElementById('refresh-pods').disabled)`), true))
  assert.equal(await evaluate(`JSON.stringify((()=>{const d=${controlDoc},panel=d.getElementById('pod-start-controls'),buttons=d.querySelectorAll('#seat-start-list button');return buttons.length===1&&buttons[0].disabled&&!d.getElementById('seat-start-connection').hidden&&d.getElementById('workspace-destination-control').parentElement.id==='seat-start-destination'&&Boolean(panel.compareDocumentPosition(d.getElementById('user-report-panel'))&4)&&Boolean(panel.compareDocumentPosition(d.querySelector('.topology-scope'))&4)&&d.documentElement.scrollWidth<=d.documentElement.clientWidth+1;})())`), true)
  await evaluate(`JSON.stringify((window.reportControlProbe.routingMatches=true,${controlDoc}.getElementById('refresh-pods').click(),true))`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(!${controlDoc}.getElementById('refresh-pods').disabled && ${controlDoc}.getElementById('seat-start-connection').hidden)`), true))
  assert.equal(await evaluate(`JSON.stringify(${controlDoc}.querySelector('#seat-start-list button').disabled)`), true, 'A result workspace is still required')
  await evaluate(`(()=>{const d=${controlDoc},workspace=d.getElementById('plugin-workspace');workspace.value=${JSON.stringify(workspace.id)};workspace.dispatchEvent(new Event('change',{bubbles:true}));d.querySelector('#seat-start-list button').click();return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(!${controlDoc}.getElementById('plugin-review').hidden)`), true))
  assert.equal(await evaluate(`JSON.stringify((()=>{const d=${controlDoc},call=window.reportControlProbe.calls.filter(c=>c.name==='setup.prepare').at(-1);return call.input.action==='launch-seat'&&call.input.seatKey===window.reportControlProbe.startSeatKey&&call.input.podKey===${JSON.stringify(observedPodFixture.pod.key)}&&call.input.instanceKey===${JSON.stringify(inventory.connection.key)}&&!d.getElementById('startup-consent').hidden&&!d.getElementById('startup-risk').checked&&d.getElementById('confirm-operation').disabled&&!window.reportControlProbe.calls.some(c=>c.name==='setup.execute'||c.name==='config.save'||c.name==='pods.connect');})())`), true)
  check('seat-start-controls', 'Pod selection exposes per-seat start reviews above reports/DAG, with visible routing/workspace prerequisites at 274px; unsupported runtimes have no start button and risk consent remains required; no agent or mutation was executed')
  await evaluate(`(()=>{const d=${controlDoc};d.getElementById('cancel-operation').click();d.querySelector('#live-seats [data-operation="export-pi-html"]').click();return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(!${controlDoc}.getElementById('plugin-review').hidden)`), true))
  assert.equal(await evaluate(`JSON.stringify((()=>{const d=${controlDoc},call=window.reportControlProbe.calls.filter(c=>c.name==='setup.prepare').at(-1);return d.querySelectorAll('#live-seats [data-operation="export-pi-html"]').length===1&&call.input.action==='export-pi-html'&&call.input.seatKey===window.reportControlProbe.startSeatKey&&call.input.podKey===${JSON.stringify(observedPodFixture.pod.key)}&&call.input.instanceKey===${JSON.stringify(inventory.connection.key)}&&d.getElementById('review-target').textContent.includes('pi-session-fixture')&&d.getElementById('review-target').textContent.includes('Native Pi history #.jsonl')&&d.getElementById('confirm-operation').textContent==='Export HTML and open in Orca';})())`), true)
  await evaluate(`JSON.stringify((${controlDoc}.getElementById('confirm-operation').click(),true))`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(!${controlDoc}.getElementById('pi-html-result').hidden&&!${controlDoc}.getElementById('pi-html-open').disabled)`), true))
  await evaluate(`JSON.stringify((${controlDoc}.getElementById('pi-html-open').click(),true))`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(window.reportControlProbe.calls.some(c=>c.name==='pi-html.open'&&c.input.id===${JSON.stringify(piExportId)}))`), true))
  assert.equal(await evaluate(`JSON.stringify(window.reportControlProbe.calls.filter(c=>c.name==='setup.execute'&&c.input.planId==='pi-html-controls-fixture').length)`), 1)
  check('pi-html-controls', 'Only the explicit Pi seat action prepares an exact instance/pod/seat export review; one simulated confirmation returns a private snapshot receipt and reopening uses only that export ID, never a second export or Native agent input')
  await evaluate(`(()=>{const d=${controlDoc};window.reportControlProbe.messageFixture=true;window.reportControlProbe.messageNavigationCount=window.reportControlProbe.calls.length;d.getElementById('view-messages').click();const input=d.getElementById('instruction-text');input.value='Fixture-only message; never send';input.dispatchEvent(new Event('input',{bubbles:true}));return JSON.stringify(true)})()`)
  assert.equal(await evaluate(`JSON.stringify((()=>{const d=${controlDoc};return d.querySelectorAll('[role="tab"]').length===3&&d.getElementById('view-messages').getAttribute('aria-selected')==='true'&&d.getElementById('dashboard-view').hidden&&!d.getElementById('messages-view').hidden&&d.getElementById('instruction-text').closest('[role="tabpanel"]').id==='messages-view'&&d.getElementById('task-body').closest('[role="tabpanel"]').id==='dashboard-view'&&d.getElementById('workspace-destination-control').parentElement.id==='messages-destination'&&d.getElementById('plugin-review').hidden&&window.reportControlProbe.calls.length===window.reportControlProbe.messageNavigationCount;})())`), true)
  await evaluate(`JSON.stringify((${controlDoc}.getElementById('messages-refresh').click(),true))`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(!${controlDoc}.getElementById('messages-refresh').disabled && [...${controlDoc}.getElementById('instruction-recipient').options].some(o=>o.value===window.reportControlProbe.startSeatKey&&!o.disabled))`), true))
  await evaluate(`(()=>{const d=${controlDoc},recipient=d.getElementById('instruction-recipient');recipient.value=window.reportControlProbe.startSeatKey;recipient.dispatchEvent(new Event('change',{bubbles:true}));const workspace=d.getElementById('plugin-workspace');workspace.value='';workspace.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify(true)})()`)
  assert.equal(await evaluate(`JSON.stringify((()=>{const d=${controlDoc};return d.querySelector('[data-operation="send-message"]').disabled&&d.getElementById('message-send-status').textContent.includes('workspace')&&d.getElementById('plugin-workspace-label').textContent.includes('required')&&d.getElementById('messages-destination').closest('#messages-actions')!==null;})())`), true)
  await evaluate(`(()=>{const d=${controlDoc},workspace=d.getElementById('plugin-workspace');workspace.value=${JSON.stringify(workspace.id)};workspace.dispatchEvent(new Event('change',{bubbles:true}));d.querySelector('[data-operation="send-message"]').click();return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(!${controlDoc}.getElementById('plugin-review').hidden)`), true))
  assert.equal(await evaluate(`JSON.stringify((()=>{const d=${controlDoc},call=window.reportControlProbe.calls.filter(c=>c.name==='setup.prepare').at(-1);return call.input.action==='send-message'&&call.input.seatKey===window.reportControlProbe.startSeatKey&&call.input.podKey===${JSON.stringify(observedPodFixture.pod.key)}&&call.input.instanceKey===${JSON.stringify(inventory.connection.key)}&&d.getElementById('review-content').textContent==='Fixture-only message; never send'&&!d.getElementById('review-effects').open&&d.getElementById('confirm-operation').textContent==='Send message'&&d.getElementById('review-essential').textContent.includes('model')&&!d.getElementById('review-response').hidden&&d.getElementById('review-response-instructions').textContent.includes('--resolution')&&d.getElementById('review-target').textContent.includes(${JSON.stringify(messageId)})&&!window.reportControlProbe.calls.some(c=>c.name==='setup.execute'&&c.input.planId==='message-controls-fixture');})())`), true)
  await evaluate(`(()=>{const d=${controlDoc};d.getElementById('view-dashboard').click();d.getElementById('view-preparation').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));return JSON.stringify(true)})()`)
  assert.equal(await evaluate(`JSON.stringify((()=>{const d=${controlDoc};return d.getElementById('view-messages').getAttribute('aria-selected')==='true'&&d.activeElement===d.getElementById('view-messages')&&d.getElementById('plugin-review').hidden&&d.getElementById('instruction-text').value==='Fixture-only message; never send'&&d.documentElement.scrollWidth<=d.documentElement.clientWidth+1;})())`), true)
  await evaluate(`(()=>{const d=${controlDoc};d.querySelector('[data-operation="send-message"]').click();return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(!${controlDoc}.getElementById('plugin-review').hidden)`), true))
  await evaluate(`JSON.stringify((${controlDoc}.getElementById('confirm-operation').click(),true))`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(!${controlDoc}.getElementById('plugin-task').hidden && !${controlDoc}.getElementById('check-task').disabled)`), true))
  assert.equal(await evaluate(`JSON.stringify(window.reportControlProbe.calls.filter(c=>c.name==='task.check').length)`), 0)
  await evaluate(`JSON.stringify((${controlDoc}.getElementById('check-task').click(),true))`)
  await until(async () => assert.equal(await evaluate(`JSON.stringify(!${controlDoc}.getElementById('task-resolution-card').hidden)`), true))
  assert.equal(await evaluate(`JSON.stringify((()=>{const d=${controlDoc};return d.getElementById('task-resolution').textContent==='Stored fixture answer <img src=x onerror=alert(1)>'&&d.querySelector('#task-resolution img')===null&&window.reportControlProbe.calls.filter(c=>c.name==='setup.execute'&&c.input.planId==='message-controls-fixture').length===1&&window.reportControlProbe.calls.filter(c=>c.name==='task.check').length===1;})())`), true)
  check('messages-controls', 'Three tabs preserve drafts/scope and explicit workspace prerequisites; message reviews carry a Native request ID and short completion guidance, one simulated confirmation yields a request receipt, and an explicit check renders the stored reply as inert text. No actual request or model was invoked')
  await evaluate(`JSON.stringify((document.getElementById('report-controls-fixture').remove(),delete window.reportControlProbe,true))`)
  check('user-report-controls', 'Shipped browser controls select exact context and load only on click; expanded text survives roster refresh/failure and 274px dark layout without horizontal overflow, clears on source edits, and uses a read-only fixture bridge')
  await evaluate(`(()=>{const frame=document.createElement('iframe');frame.id='visibility-fixture';frame.src='/visualizer/plugin.html';frame.style.cssText='position:fixed;top:10px;left:10px;width:500px;height:300px;z-index:2000;background:white';document.body.append(frame);return JSON.stringify(true)})()`)
  await until(async () => assert.equal(await evaluate('JSON.stringify(document.getElementById("visibility-fixture").contentDocument?.readyState === "complete")'), true))
  await evaluate(`(async()=>{const m=await import('/visualizer/workspace.mjs');const frame=document.getElementById('visibility-fixture'),w=frame.contentWindow;window.visibilitySamples=[];window.visibilityProbe=m.watchPanelVisibility({document:w.document,window:w,IntersectionObserver:w.IntersectionObserver,changed:(visible,known)=>window.visibilitySamples.push({visible,known})});return JSON.stringify(true)})()`)
  await evaluate('JSON.stringify(document.getElementById("visibility-fixture").style.display="none")')
  await until(async () => assert.equal(await evaluate('JSON.stringify(window.visibilitySamples.at(-1)?.visible===false && window.visibilitySamples.at(-1)?.known===true)'), true))
  await evaluate('JSON.stringify(document.getElementById("visibility-fixture").style.display="")')
  await evaluate('JSON.stringify(document.getElementById("visibility-fixture").style.visibility="hidden")')
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(await evaluate('JSON.stringify(window.visibilitySamples.at(-1)?.visible===false)'), true)
  await evaluate('(()=>{window.visibilityProbe.dispose();document.getElementById("visibility-fixture").remove();return JSON.stringify(true)})()')
  check('refresh-visibility', 'The HTML visibility gate conservatively pauses a same-origin frame hidden with display:none or visibility:hidden; no private Orca event is assumed')
  const inspected = observedPodFixture.seats[1].logicalId
  await evaluate(`JSON.stringify([...document.querySelectorAll('#diagram [role=button]')].find(e=>e.getAttribute('aria-label')===${JSON.stringify('Inspect ' + observedPodFixture.seats[1].logicalId)}).dispatchEvent(new MouseEvent('click',{bubbles:true})))`)
  assert.equal(await evaluate('JSON.stringify(document.getElementById("agent-name").textContent)'), inspected)
  const dashboardShot = await orca(['screenshot', '--page', previewPage])
  await copyFile(dashboardShot.result.path, path.join(root, 'dashboard-preview.png'))
  await evaluate('(()=>{document.getElementById("yaml-tools").open=true;const source=document.getElementById("yaml-source");source.value+="\\n# retained across internal views";source.dispatchEvent(new Event("input",{bubbles:true}));return JSON.stringify(true)})()')
  assert.equal(await evaluate('JSON.stringify(document.getElementById("declaration-mode-note").hidden)'), false)
  await evaluate('JSON.stringify(document.getElementById("view-preparation").click() || true)')
  await evaluate('(()=>{const button=document.getElementById("example-next");button.closest("details").open=true;button.click();return JSON.stringify(true)})()')
  assert.match(await evaluate('JSON.stringify(document.getElementById("example-step-count").textContent)'), /^Step 2 /)
  assert.equal(await evaluate('JSON.stringify(document.getElementById("workspace-destination-control").parentElement.id)'), 'preparation-destination')
  assert.equal(await evaluate('JSON.stringify(document.getElementById("yaml-source").value.endsWith("# retained across internal views"))'), true)
  assert.equal(await evaluate('JSON.stringify([...document.querySelectorAll("[data-operation]")].every(button=>button.disabled))'), true)
  const preparationShot = await orca(['screenshot', '--page', previewPage])
  await copyFile(preparationShot.result.path, path.join(root, 'preparation-preview.png'))
  await orca(['tab', 'close', '--page', previewPage]); previewPage = undefined
  previewServer.closeAllConnections(); await new Promise(resolve => previewServer.close(resolve)); previewServer = undefined
  await orca(['plugin', 'open', 'local.openrig-for-orca', '--panel', 'openrig'])
  for (const [theme, width] of [['light', '440'], ['dark', '320']]) {
    const shot = await orca(['plugin', 'shot', 'local.openrig-for-orca', '--panel', 'openrig', '--theme', theme, '--width', width, '--out', path.join(root, `openrig-${theme}.png`)])
    assert.deepEqual(shot.result.errors, [])
    assert.equal(shot.result.pendingRequests || 0, 0)
  }
  report.visual = 'captured-seeded-profile'
  check('unified-panel', 'One native HTML panel captured in light/dark; its three-view navigation, inline diagram selection and internal walkthrough exercised in the isolated browser without a worker bridge')
  if (keep) console.log('Keeping this disposable daemon and plugin loaded for manual inspection.')
  report.exitCode = 0
} catch (error) {
  report.error = `${browserStep ? `${browserStep}: ` : ''}${String(error)}`
  if (previewPage) try {
    const inspected = await orca(['eval', '--page', previewPage, '--expression', 'JSON.stringify({hidden:document.getElementById("seat-report-tooltip")?.hidden,hasPre:!!document.querySelector("#seat-report-tooltip pre"),labels:[...document.querySelectorAll("#seat-report-tooltip strong,#seat-report-tooltip p")].map(e=>e.textContent),nodeCount:document.querySelectorAll("#diagram g.node[role=button]").length})'])
    report.tooltipDiagnostic = JSON.parse(inspected.result.result)
  } catch { /* Diagnostics never read a report body or prevent cleanup. */ }
  report.exitCode = 1
  process.exitCode = 1
} finally {
  if (!keep) {
    const cleanup = async (label, task) => {
      try { await task() } catch (error) { report.warnings.push(`Cleanup ${label}: ${error.message}`); process.exitCode = 1 }
    }
    if (previewPage) await cleanup('preview page', () => orca(['tab', 'close', '--page', previewPage]))
    if (previewServer) await cleanup('preview server', async () => { previewServer.closeAllConnections(); await new Promise(resolve => previewServer.close(resolve)) })
    if (terminalId) await cleanup('seat view', () => orca(['terminal', 'close', '--terminal', terminalId]))
    if (frozenFixture && rig) await cleanup('frozen fixture', () => invoke(rig.file, [...rig.args, 'down', frozenFixture], { env: rigEnv }))
    if (fixtureStarted && rig) await cleanup('fixture', () => invoke(rig.file, [...rig.args, 'down', rigName], { env: rigEnv }))
    if (daemonStarted && rig) await cleanup('daemon', () => invoke(rig.file, [...rig.args, 'daemon', 'stop'], { env: rigEnv }))
    if (loaded) await cleanup('plugin', () => orca(['plugin', 'dev', 'unload', stage]))
    if (runtimePid) for (const workspacePath of ownedWorkspacePaths) {
      await cleanup('sandbox terminals', () => orca(['terminal', 'close', '--worktree', `path:${workspacePath}`, '--all']))
    }
    // Orca's terminal host intentionally outlives its desktop. Stop only PIDs whose command
    // independently proves ownership by this disposable profile, never a shared/user daemon.
    const stopOwned = async pid => {
      const canonical = await realpath(root)
      const owned = async () => {
        const exitDeadline = Date.now() + 5000
        for (;;) {
          let current
          try { current = (await invoke('ps', ['-p', String(pid), '-o', 'stat=,command='])).stdout } catch (error) {
            if (error.code === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim() && !error.killed) return false
            throw new Error(`Cannot inspect process ${pid}; termination remains unverified`)
          }
          const state = processSampleState(current, [root, canonical])
          if (state === 'gone') return false
          if (state === 'owned') return true
          // macOS can briefly report '?E (Orca)' after exit begins and argv disappears.
          // Observe that transition; never signal an unreadable or potentially reused PID.
          if (state === 'exiting' && Date.now() < exitDeadline) {
            await new Promise(resolve => setTimeout(resolve, 100)); continue
          }
          throw new Error(`Process ${pid} ownership could not be proven; no signal sent`)
        }
      }
      if (!await owned()) return
      process.kill(pid, 'SIGTERM')
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        if (!await owned()) return
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      // A disposable terminal host can deliberately survive desktop shutdown. Only after
      // closing this fresh profile's terminals and re-proving its identity may we force it off.
      if (await owned()) {
        process.kill(pid, 'SIGKILL')
        await until(async () => assert.equal(await owned(), false), 5000)
      }
    }
    if (runtimePid) await cleanup('sandbox desktop', () => stopOwned(runtimePid))
    const daemonDir = path.join(root, 'orca', 'daemon')
    try {
      for (const file of await readdir(daemonDir)) {
        if (!/^daemon-v\d+\.pid$/.test(file)) continue
        const record = JSON.parse(await readFile(path.join(daemonDir, file), 'utf8'))
        if (Number.isSafeInteger(record.pid) && record.pid > 1) await cleanup('sandbox terminal host', () => stopOwned(record.pid))
      }
    } catch (error) { if (error.code !== 'ENOENT') { report.warnings.push(`Terminal-host cleanup: ${error.message}`); process.exitCode = 1 } }
    if (process.exitCode) report.exitCode = 1
    else check('cleanup-complete', 'Fixture, daemon, plugin, terminals and profile-owned desktop/terminal-host processes cleaned up')
  }
  if (output) {
    await mkdir(artifactDirectory, { recursive: true })
    for (const file of ['openrig-light.png', 'openrig-dark.png', 'dashboard-preview.png', 'preparation-preview.png']) {
      try { await copyFile(path.join(root, file), path.join(artifactDirectory, file)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  await writeFile(path.join(artifactDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
