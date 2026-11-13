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
let frozenFixture

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
  await orca(['plugin', 'open', 'local.openrig-for-orca', '--panel', 'examples'])
  for (const [theme, width] of [['light', '440'], ['dark', '320']]) {
    const shot = await orca(['plugin', 'shot', 'local.openrig-for-orca', '--panel', 'examples', '--theme', theme, '--width', width, '--act', '[{"press":{"text":"Next step"}}]', '--out', path.join(root, `examples-${theme}.png`)])
    assert.deepEqual(shot.result.errors, [])
    assert.ok(shot.result.actions.every(action => action.ok))
    assert.equal(shot.result.pendingRequests || 0, 0)
  }
  report.visual = 'captured-seeded-profile'
  check('example-panel', 'Example panel captured at narrow light/dark sizes after a real walkthrough control action; onboarding seeded before startup')
  if (keep) console.log('Keeping this disposable daemon and plugin loaded for manual inspection.')
  report.exitCode = 0
} catch (error) {
  report.error = String(error)
  report.exitCode = 1
  process.exitCode = 1
} finally {
  if (!keep) {
    const cleanup = async (label, task) => {
      try { await task() } catch (error) { report.warnings.push(`Cleanup ${label}: ${error.message}`); process.exitCode = 1 }
    }
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
    for (const file of ['examples-light.png', 'examples-dark.png']) {
      try { await copyFile(path.join(root, file), path.join(artifactDirectory, file)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  await writeFile(path.join(artifactDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
