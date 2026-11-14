import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { commandEnvironment, environment, fail, findExecutable, instanceDirectory, OPENRIG_VERSION, quote, rigInvocation, shellCommand } from './runtime.mjs'
import { operationInstance } from './pods.mjs'
import { prepareLaunchReview } from './launch-review.mjs'
import { exampleBundle, writeExampleCommand } from './examples.mjs'
import { canInstruct, instructionEndpoint, instructionTextError } from './seat-instructions.mjs'
import { canStartSeat, canQueueTask, taskTextError } from './seat-tasks.mjs'
import { taskBodyPath } from './task-files.mjs'

export const SOURCES = {
  rig: 'https://github.com/mvschwarz/openrig',
  tmux: 'https://github.com/tmux/tmux/wiki/Installing',
  node: 'https://nodejs.org/en/download',
  claude: 'https://code.claude.com/docs/en/setup',
  codex: 'https://developers.openai.com/codex/cli/'
}

export class PlanStore {
  #plans = new Map()
  constructor(now = () => Date.now()) { this.now = now }
  add(plan, fingerprint) {
    for (const [id, entry] of this.#plans) if (entry.expires < this.now()) this.#plans.delete(id)
    const id = randomUUID()
    const expires = this.now() + 5 * 60 * 1000
    this.#plans.set(id, { plan: structuredClone(plan), fingerprint, expires })
    return { ...plan, id, expires }
  }
  consume(id, fingerprint) {
    const entry = this.#plans.get(id)
    this.#plans.delete(id) // At most once, including ambiguous terminal creation failures.
    if (!entry || entry.expires < this.now()) throw fail('plan_expired', 'Prepare a new plan; this confirmation expired or was already used')
    if (entry.fingerprint !== fingerprint) throw fail('plan_stale', 'Configuration changed. Review a new plan')
    return entry.plan
  }
}

export const fingerprint = (config, workspace) => JSON.stringify([config, workspace.id, workspace.path])

async function packageVersion(name, fetcher = fetch) {
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(12000) })
  if (!response.ok) throw fail('download_failed', `Cannot resolve the official ${name} package; open its installation guide instead`)
  const data = await response.json()
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(data.version)) throw fail('download_failed', 'Registry returned an invalid package version')
  return data.version
}

function npmCommand(snapshot, args) {
  if (!snapshot.tools.node || !snapshot.tools.npm) throw fail('node_required', 'Select compatible Node and npm first')
  // Reuse 1Password's npm shell plugin when installed; never extract registry credentials.
  return snapshot.tools.op
    ? shellCommand(snapshot.tools.op, ['plugin', 'run', '--', 'npm', ...args])
    : shellCommand(snapshot.tools.npm, args)
}

export async function buildPlan(action, config, snapshot, workspace, input = {}, options = {}) {
  if (!workspace || (workspace.hostId && workspace.hostId !== 'local')) throw fail('local_workspace_required', 'Choose a local Orca workspace; remote execution is not supported yet')
  const env = commandEnvironment(config, snapshot, options.baseEnv)
  let command, title, source, example, launchReview, instruction, seatLaunch, queueTask, writes = [], warnings = []
  const root = config.root
  if (['install-rig', 'install-claude', 'install-codex'].includes(action) && snapshot.tools.op && config.npmPath) {
    const selectedEnv = environment({ ...config, nodePath: snapshot.tools.node }, options.baseEnv)
    const actual = await findExecutable('npm', selectedEnv)
    if (!actual || await realpath(actual) !== await realpath(config.npmPath)) {
      throw fail('npm_override_conflict', '1Password runs npm by command name. Choose the npm that resolves on the selected Node PATH, or clear the npm override; no different npm was run.')
    }
  }
  if (['example-demo', 'example-claude', 'example-codex'].includes(action)) {
    if (!snapshot.tools.node) throw fail('node_required', 'Choose compatible Node before creating example files')
    const kind = action.slice(8)
    if (kind === 'demo' && !snapshot.installed) throw fail('dependencies_missing', 'Install OpenRig and tmux, then start the no-agent daemon in Setup')
    const id = randomUUID().replaceAll('-', '').slice(0, 12)
    const bundle = exampleBundle(kind, id, path.join(root, 'examples', id))
    example = { id, kind, rigName: bundle.rigName, directory: bundle.directory, specPath: bundle.specPath, configRoot: root, ...(kind === 'demo' ? { instance: operationInstance(config) } : {}) }
    title = kind === 'demo' ? 'Create and start a terminal-only topology demo' : `Create ${kind} Build & Review template (do not launch)`
    source = SOURCES.rig
    writes = [bundle.directory, ...(kind === 'demo' ? [instanceDirectory(config)] : [])]
    command = writeExampleCommand(snapshot.tools.node, bundle)
    warnings = [kind === 'demo' ? 'SIMULATION ONLY: two real tmux terminal seats print prerecorded role descriptions. They are not AI agents and do not perform or exchange work. No model credentials are required.' : 'Creates an example project, role guidance and a two-agent local RigSpec. No agent, login, or model call is started. Launch this spec separately from Teams after reviewing runtime, model and permissions.', 'Creates a new private directory exclusively; existing project files are not overwritten.']
    if (kind === 'demo') {
      const rig = await rigInvocation(snapshot.tools.rig, snapshot.tools.node)
      command += ` && export OPENRIG_NO_KERNEL=1 && ${shellCommand(rig.file, [...rig.args, 'up', bundle.specPath, '--cwd', bundle.project])}`
      warnings.push('Use Stop demo to deliberately stop these seats. Closing their views only detaches. This may write OpenRig discovery skills under the effective HOME.')
    }
  } else if (action === 'stop-example') {
    example = input.example
    if (!example || example.kind !== 'demo' || example.configRoot !== root || example.instance !== operationInstance(config) || !/^orca-example-demo-[a-f0-9]{12}$/.test(example.rigName)) throw fail('example_unowned', 'Only a demo created by this plugin in this instance can be stopped')
    if (!snapshot.installed) throw fail('dependencies_missing', 'OpenRig and tmux are required')
    const rig = await rigInvocation(snapshot.tools.rig, snapshot.tools.node)
    title = 'Stop this terminal-only demo'
    source = SOURCES.rig
    writes = [instanceDirectory(config)]
    warnings = ['Explicitly stops only this recorded demo team, including its two tmux seats. Example files are kept. Other teams and views are not targeted.']
    command = shellCommand(rig.file, [...rig.args, 'down', example.rigName])
  } else if (action === 'launch-seat' || action === 'create-task') {
    if (!snapshot.installed) throw fail('dependencies_missing', 'Verify Node, OpenRig, tmux and SQLite first')
    const seat = input.seat
    if (action === 'launch-seat' && !canStartSeat(seat)) throw fail('seat_unavailable', 'Choose one stopped, exited, detached or never-started agent seat. Running, unknown, shell and kernel seats are refused.')
    if (action === 'create-task') {
      if (!canQueueTask(seat)) throw fail('seat_unavailable', 'Choose one running local agent without an attention request; shell, remote and kernel targets are refused')
      const problem = taskTextError(input.summary, input.body)
      if (problem) throw fail('invalid_task', problem)
    }
    const rig = await rigInvocation(snapshot.tools.rig, snapshot.tools.node)
    const local = `unset OPENRIG_SESSION_NAME OPENRIG_NODE_ID OPENRIG_RIG_ID RIGGED_SESSION_NAME RIGGED_NODE_ID RIGGED_RIG_ID; export OPENRIG_URL=${quote(instructionEndpoint(config))}; export OPENRIG_HOST_SELECTED=local; export OPENRIG_NO_KERNEL=1;`
    source = SOURCES.rig
    if (action === 'launch-seat') {
      seatLaunch = { ...seat }
      title = `Start one seat: ${seat.logicalId}`
      writes = [instanceDirectory(config), 'The selected native seat cwd, provider files, hooks, logs and tmux session']
      warnings = ['Starts only this registered rig ID and logical ID. No --seats, fresh occupant, stop, model override or kernel recovery is requested. Other running seats remain unchanged.', 'This is a command review, not a complete native startup plan. First-start --plan is not supported for never-started materialized seats. Model defaults, permissions, provider configuration and hooks remain unverified; explicit startup-risk acknowledgment is required.', 'May start paid model calls and edit files. A declared cwd, role or read-only terminal view is not an OS sandbox. Inspect the CLI result and refresh; a result terminal is not proof that the seat is running.']
      command = `${local} ${shellCommand(rig.file, [...rig.args, 'launch', '--json', '--', seat.rigId, seat.logicalId])}`
    } else {
      const id = `qitem-orca-${randomUUID().replaceAll('-', '')}`
      queueTask = { id, destination: seat.session, key: seat.key, runtime: seat.runtime, summary: input.summary, body: input.body, bodyFile: taskBodyPath(root, id) }
      title = `Register task for ${seat.session}`
      writes = [instanceDirectory(config), queueTask.bodyFile, 'One durable queue row and the native destination nudge/message history']
      warnings = ['This registers work with the selected destination; it does not claim that the agent accepted, completed or independently verified the work. Native nudges may invoke a paid model.', 'The source orca-gui@external is a declared external source, not an authenticated human or a forged seat identity. No guaranteed human reply route is created.', 'The preassigned task ID is not proof of persistence. After confirmation, use Check task registration to read the matching row without creating or nudging again. A missing row or timeout is not permission to create another ID for the same work.', 'The title/body are saved in private action files and native queue history. Do not include credentials. The destination workspace only hosts the result terminal and does not change the agent cwd.']
      command = `${local} ${shellCommand(rig.file, [...rig.args, 'queue', 'create', '--id', id, '--source', 'orca-gui@external', '--destination', seat.session, `--summary=${input.summary}`, '--body-file', queueTask.bodyFile, '--json'])}`
    }
  } else if (action === 'send-instruction') {
    if (!snapshot.installed) throw fail('dependencies_missing', 'Verify Node, OpenRig, tmux and SQLite first')
    if (!canInstruct(input.seat)) throw fail('seat_unavailable', 'Choose a running, explicitly idle Claude Code, Codex or Pi seat without an attention request. Shell and remote targets are refused.')
    const problem = instructionTextError(input.message)
    if (problem) throw fail('invalid_instruction', problem)
    const seat = input.seat
    const rig = await rigInvocation(snapshot.tools.rig, snapshot.tools.node)
    instruction = { key: seat.key, session: seat.session, runtime: seat.runtime, text: input.message }
    title = `Send instruction to ${seat.session}`
    source = SOURCES.rig
    writes = ['The selected agent terminal and OpenRig message/audit history', 'The agent may edit files and use paid model capacity; its cwd is not a security sandbox']
    warnings = ['Sends one terminal message, not a durable queue task or ownership handoff. The sender may be shown as unknown; no reply route is guaranteed. Delivery is not acknowledgment or task completion.', 'The existing local instance and selected seat are rechecked before opening the result terminal. OpenRig must still prove idle within one second and keeps its native prompt/permission guard; no force, raw input or approval bypass is used.', 'A timeout or missing output can follow delivery. Inspect the recipient before any resend; no automatic retry is performed.', 'The destination Orca workspace only hosts the CLI result terminal; it does not change the agent cwd. The reviewed text is saved in a private action script and may appear in local terminal/message history. Do not include credentials.']
    command = `export OPENRIG_URL=${quote(instructionEndpoint(config))}; export OPENRIG_HOST_SELECTED=local; ${shellCommand(rig.file, [...rig.args, 'send', '--wait-for-idle', '1', '--json', '--', seat.session, input.message])}`
  } else if (action === 'install-rig') {
    title = `Install OpenRig ${OPENRIG_VERSION}`
    source = SOURCES.rig
    writes = [path.join(root, 'runtime'), 'npm cache in the effective HOME (or configured npm cache)']
    command = npmCommand(snapshot, ['install', '--prefix', path.join(root, 'runtime'), '--no-audit', '--no-fund', `@openrig/cli@${OPENRIG_VERSION}`])
    warnings = ['Downloads official npm packages and runs their install scripts, including native SQLite installation. No rig setup, global install, Herdr, or agent launch. Existing external rig installations are not modified.', 'After installation, select the managed rig path if you explicitly configured an external rigPath. Recheck the environment to verify the SQLite binding.']
  } else if (action === 'install-tmux') {
    title = 'Install tmux'
    source = SOURCES.tmux
    writes = ['System/package-manager installation directories']
    warnings = ['Uses your existing package manager in an Orca terminal. It may request administrator approval. No Homebrew bootstrap or downloaded shell script is run.']
    const t = snapshot.tools
    const sudo = t.sudo ? [t.sudo] : []
    if (snapshot.platform === 'darwin' && t.brew) command = shellCommand(t.brew, ['install', 'tmux'])
    else if (snapshot.platform === 'darwin' && t.port) command = shellCommand(sudo[0] || t.port, sudo.length ? [t.port, 'install', 'tmux'] : ['install', 'tmux'])
    else if (snapshot.platform === 'linux') {
      const manager = [['apt-get', ['install', 'tmux']], ['dnf', ['install', 'tmux']], ['yum', ['install', 'tmux']], ['pacman', ['-S', 'tmux']], ['zypper', ['install', 'tmux']], ['apk', ['add', 'tmux']]].find(([name]) => t[name])
      if (manager) command = shellCommand(sudo[0] || t[manager[0]], [...(sudo.length ? [t[manager[0]]] : []), ...manager[1]])
    }
    if (!command) throw fail('manual_install_required', `No supported package manager found. Follow ${SOURCES.tmux}, then set tmuxPath and recheck. Homebrew is not required.`)
  } else if (action === 'install-claude' || action === 'install-codex') {
    const provider = action.slice(8)
    const name = provider === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex'
    const version = await packageVersion(name, options.fetcher)
    title = `Install ${provider} ${version}`
    source = SOURCES[provider]
    writes = [path.join(root, 'providers'), 'npm cache in the effective HOME (or configured npm cache)']
    warnings = ['Downloads the provider’s official npm package and runs its install scripts. Does not sign in, copy credentials, or launch an agent.']
    command = npmCommand(snapshot, ['install', '--prefix', path.join(root, 'providers'), '--no-audit', '--no-fund', `${name}@${version}`])
  } else if (action === 'login-claude' || action === 'login-codex') {
    const provider = action.slice(6)
    if (!snapshot.tools[provider]) throw fail('provider_missing', `Install ${provider} first`)
    title = `Sign in to ${provider}`
    source = SOURCES[provider]
    writes = [provider === 'codex' ? config.codexHome || path.join(config.homePath || process.env.HOME, '.codex') : config.claudeConfigDir || path.join(config.homePath || process.env.HOME, '.claude')]
    warnings = ['Uses the provider’s own interactive login in Orca’s terminal. The plugin does not read, copy, or persist credentials.']
    command = shellCommand(snapshot.tools[provider], provider === 'claude' ? ['auth', 'login'] : ['login'])
  } else if (['start-daemon', 'console', 'launch-team', 'launch-example'].includes(action)) {
    if (!snapshot.installed) throw fail('dependencies_missing', 'Verify Node, OpenRig, tmux and SQLite first')
    const rig = await rigInvocation(snapshot.tools.rig, snapshot.tools.node)
    const rigCmd = args => shellCommand(rig.file, [...rig.args, ...args])
    source = SOURCES.rig
    writes = [instanceDirectory(config), 'OpenRig-managed discovery skills under the effective HOME/.claude/skills and HOME/.agents/skills']
    warnings = ['OpenRig is third-party executable code. Startup can seed discovery skills; team/seat startup may also modify provider trust, hooks, plugins and project guidance. OPENRIG_HOME alone does not isolate those files.', 'No permission bypass, automatic approval, Herdr, cmux, Ghostty, or rig setup is requested by this plugin.']
    if (action === 'start-daemon') {
      if (config.instanceHome) throw fail('existing_instance_start_refused', 'This connection uses an existing OpenRig home. Starting its daemon/kernel is not part of managed setup; inspect it separately.')
      title = 'Start this OpenRig instance (no agents)'
      command = rigCmd(['daemon', 'start', '--no-kernel', '--host', '127.0.0.1', '--port', config.daemonPort])
      warnings.push('Starts no kernel or agent team. No agent login is required. Closing this terminal does not stop the daemon.')
    } else if (action === 'console') {
      title = 'Open OpenRig dashboard in Orca'
      // --shared attaches a kernel-owned terminal, which a no-kernel daemon lacks.
      command = rigCmd(['tui'])
      warnings.push('Use the dashboard to inspect and manage OpenRig. Any kernel/agent launch remains a separate user choice inside OpenRig.')
    } else {
      if (!snapshot.ready || config.provider === 'none') throw fail('agent_setup_required', 'Select and authenticate your provider before launching a team')
      if (action === 'launch-example') {
        example = input.example
        if (!example || !['claude', 'codex'].includes(example.kind) || example.configRoot !== root || !/^orca-example-(claude|codex)-[a-f0-9]{12}$/.test(example.rigName)) throw fail('example_unowned', 'Choose a recorded real-agent template from this instance')
        if (config.provider !== 'both' && config.provider !== example.kind) throw fail('provider_mismatch', 'Select and authenticate the provider used by this template first')
      }
      const spec = String(example?.specPath || input.spec || '').trim()
      if (!spec || !path.isAbsolute(spec) || /[\0\r\n]/.test(spec)) throw fail('invalid_spec', 'Verified launches require an absolute local YAML spec. Export library specs or create an example template first.')
      title = `Review frozen launch of ${path.basename(spec)}`
      const cwd = example ? path.join(example.directory, 'project') : workspace.path
      launchReview = await prepareLaunchReview(spec, cwd, config, snapshot, options)
      writes.push(launchReview.directory, cwd, config.codexHome || 'Selected Codex home/config.toml', config.claudeConfigDir || 'Selected Claude configuration and workspace trust')
      warnings.push('Preparation copied the declared spec and resources into a private, integrity-checked bundle. Execution uses that snapshot, never the mutable source YAML. No agents have been launched.', 'The terminal displays bundle-derived runtime/model/permission declarations and explicit unverified native/host settings. Unknown settings require ACCEPT UNVERIFIED SETTINGS before LAUNCH. The review expires after five minutes. Model usage may be billable.')
      command = shellCommand(snapshot.tools.node, [launchReview.programPath])
    }
  } else throw fail('invalid_action', 'Unknown setup action')
  writes.push(path.join(root, 'actions'))
  const terminalCommand = shellCommand('/bin/sh', ['-c', `${env} ${command}`])
  if (terminalCommand.length > 12000) throw fail('plan_display_too_large', 'The exact command cannot be displayed completely. Shorten the message or executable/environment paths before preparing a new plan.')
  return { action, title, source, writes, warnings, workspaceId: workspace.id,
    command: terminalCommand, ...(example ? { example } : {}), ...(launchReview ? { launchReview } : {}), ...(instruction ? { instruction } : {}), ...(seatLaunch ? { seatLaunch } : {}), ...(queueTask ? { queueTask } : {}) }
}
