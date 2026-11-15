#!/usr/bin/env node
// Disposable, real Orca + OpenRig integration smoke test. No model calls or copied logins.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readdir, readFile, realpath, copyFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { configFrom, environment, OPENRIG_VERSION, rigInvocation } from '../src/runtime.mjs'
import { stagePlugin } from './stage.mjs'
import { exampleBundle, writeExampleCommand } from '../src/examples.mjs'
import { prepareLaunchReview, stageLaunchProgram } from '../src/launch-review.mjs'
import { optionValue, processSampleState, seedFreshOrcaProfile } from './ci-support.mjs'
import { startTopologyPreview } from './preview-topology.mjs'

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
  let config = configFrom({ provider: 'none', root: path.join(root, 'data'), homePath: install ? '' : home,
    rigPath: install ? '' : path.resolve(rigPath), nodePath: process.execPath, daemonPort: String(await availablePort()) })
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
  observedPodFixture = { pod: observedPod, seats: inventory.seats.filter(s => s.rigId === observedPod.rigId && s.podId === observedPod.podId), observedAt: inventory.observedAt, relations, reportPreview }
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
  await until(async () => assert.equal(await evaluate('JSON.stringify(document.querySelectorAll(\'[role="tab"]\').length)'), 2))
  await evaluate('JSON.stringify(document.getElementById("view-dashboard").click() || true)')
  assert.equal(await evaluate('JSON.stringify(document.querySelectorAll("#diagram svg").length)'), 0)
  assert.equal(await evaluate('JSON.stringify(document.getElementById("workspace-destination-control").parentElement.id)'), 'dashboard-destination')
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
  check('report-tooltip', 'A task-owned native outbox record produced a <=500-byte UTF-8 hover/focus preview; HTML remained inert, Escape dismissed it, and the body stayed outside the SVG')
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
  check('unified-panel', 'One native HTML panel captured in light/dark; its two-view navigation, inline diagram selection and internal walkthrough exercised in the isolated browser without a worker bridge')
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
