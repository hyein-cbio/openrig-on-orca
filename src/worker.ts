import type { OrcaWorkerApi } from 'orca/worker'
import { buildPlan, fingerprint, PlanStore } from './plans.mjs'
import { stageAction } from './action-files.mjs'
import { stageLaunchProgram } from './launch-review.mjs'
import { createTerminalView, persistTerminalReceipt, revealTerminal } from './terminal-receipt.mjs'
import { commandEnvironment, configFrom, daemonState, discover, fail, listInstructionSeats, listSeats, rigInvocation, shellCommand, run } from './runtime.mjs'
import { canInstruct, instructionTextError } from './seat-instructions.mjs'
import { canStartSeat, canQueueTask, taskTextError, sameSeatDefinition } from './seat-tasks.mjs'
import { stageTaskBody, taskHash, validTaskId, checkTask } from './task-files.mjs'
import { readPodInventory, connectedPodConfig, assertPodInstance } from './pod-inventory.mjs'
import { resolveTuiConsole, recheckTuiConsole } from './tui-console.mjs'
import { readUserReports } from './user-reports.mjs'
import { readSeatReport } from './seat-reports.mjs'
import { readPodRelations } from './pod-relations.mjs'
import { podKeyOf } from './pods.mjs'
import type { Config, ExampleRecord, Seat, Workspace } from './protocol'

const CONFIG = 'config.v1'

export default function activate(orca: OrcaWorkerApi): void {
  const plans = new PlanStore()
  const getConfig = async (): Promise<Config> => configFrom((await orca.storage.get(CONFIG)) || {})
  async function workspaces(): Promise<Workspace[]> {
    const result = await orca.host.call('workspace.list')
    if (result.truncated) throw fail('workspace_list_truncated', 'Workspace list is incomplete; narrow your Orca workspace inventory before using this plugin')
    return result.workspaces.map(w => ({ id: w.id, name: w.name, project: w.project || null, path: w.path, hostId: w.hostId || null }))
  }
  async function workspace(id: string): Promise<Workspace> {
    if (typeof id !== 'string' || !id) throw fail('workspace_required', 'Choose the destination Orca workspace')
    const found = (await workspaces()).find(w => w.id === id)
    if (!found || (found.hostId && found.hostId !== 'local')) throw fail('local_workspace_required', 'Choose an existing local Orca workspace; remote/WSL host bridging is not supported yet')
    return found
  }
  async function state() {
    const config = await getConfig()
    const [snapshot, spaces] = await Promise.all([discover(config), workspaces()])
    return { config, snapshot, workspaces: spaces, daemon: await daemonState(config, snapshot) }
  }
  orca.panels.handle('environment.scan', state)
  orca.panels.handle('config.save', async input => {
    const config = configFrom(input)
    await orca.storage.set(CONFIG, config)
    return state()
  })
  async function observationTools(config: Config, signal: AbortSignal) {
    const execute: typeof run = (file, args, options) => {
      if (signal.aborted) throw fail('cancelled', 'Observation cancelled before another read')
      return run(file, args, { ...options, signal })
    }
    const snapshot = await discover({ ...config, provider: 'none' }, { execute })
    if (signal.aborted) throw fail('cancelled', 'Observation cancelled')
    return { snapshot, execute }
  }
  orca.panels.handle('pods.list', async (input, { signal }) => {
    const config = await getConfig(), { snapshot, execute } = await observationTools(config, signal)
    return readPodInventory(config, snapshot, input?.source || 'tui', execute)
  })
  orca.panels.handle('pods.edges', async (input, { signal }) => {
    const config = await getConfig(), { snapshot, execute } = await observationTools(config, signal)
    return readPodRelations(config, snapshot, input, { signal, execute })
  })
  orca.panels.handle('user.reports', async (input, { signal }) => {
    const config = await getConfig(), { snapshot, execute } = await observationTools(config, signal)
    return readUserReports(config, snapshot, input, { signal, execute })
  })
  orca.panels.handle('seat.report', async (input, { signal }) => {
    const config = await getConfig()
    return readSeatReport(config, await discover({ ...config, provider: 'none' }), input, { signal })
  })
  orca.panels.handle('pods.connect', async input => {
    if (typeof input.expectedKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedKey)) throw fail('invalid_instance', 'Refresh the observed instance before connecting')
    const config = await connectedPodConfig(await getConfig(), input.source, input.expectedKey)
    await orca.storage.set(CONFIG, config) // Plugin-owned routing only; no native config, daemon or seat is changed.
    return state()
  })
  orca.panels.handle('setup.prepare', async (input, { signal }) => {
    const config = await getConfig()
    const target = await workspace(input.workspaceId)
    if (input.podKey !== undefined) await assertPodInstance(config, input.instanceKey)
    const snapshot = await discover(input.action === 'console' ? { ...config, provider: 'none' } : config)
    const consoleTarget = input.action === 'console' ? await resolveTuiConsole(config, snapshot, input.consoleSource ?? 'configured', input.instanceKey) : null
    let example, instructionSeat
    if (input.action === 'send-instruction') {
      const problem = instructionTextError(input.message)
      if (problem) throw fail('invalid_instruction', problem)
      if (typeof input.seatKey !== 'string' || !input.seatKey || input.seatKey.length > 1000) throw fail('seat_unavailable', 'Choose one seat from the refreshed list')
      instructionSeat = (await listInstructionSeats(config, snapshot)).find((seat: Seat) => seat.key === input.seatKey)
    }
    if (input.action === 'launch-seat' || input.action === 'create-task' || input.action === 'send-message') {
      if (input.action === 'create-task' || input.action === 'send-message') {
        const problem = input.action === 'send-message' ? instructionTextError(input.message) : taskTextError(input.summary, input.body)
        if (problem) throw fail('invalid_task', problem)
      }
      if (typeof input.seatKey !== 'string' || !input.seatKey || input.seatKey.length > 1000) throw fail('seat_unavailable', 'Choose one registered seat from the refreshed list')
      instructionSeat = (await listInstructionSeats(config, snapshot)).find((seat: Seat) => seat.key === input.seatKey)
    }
    if (['example-demo', 'stop-example', 'launch-example', 'launch-team'].includes(input.action)) await listSeats(config, snapshot)
    if (input.action === 'stop-example' || input.action === 'launch-example') {
      if (!/^[a-f0-9]{12}$/.test(input.exampleId || '')) throw fail('example_unowned', 'Choose a recorded demo')
      example = await orca.storage.get(`example:${input.exampleId}`)
    }
    if (input.podKey !== undefined && (typeof input.podKey !== 'string' || input.podKey.length > 1000 || !instructionSeat || podKeyOf(instructionSeat) !== input.podKey)) throw fail('pod_changed', 'The selected seat is not in the reviewed pod of this configured instance. Refresh pods; no operation was prepared.')
    const plan = await buildPlan(input.action, consoleTarget?.config || config, snapshot, target, { spec: input.spec, example, seat: instructionSeat, message: input.message, summary: input.summary, body: input.body }, { signal })
    const scoped = input.podKey ? { ...plan, pod: { key: input.podKey, rigId: instructionSeat.rigId, podId: instructionSeat.podId, namespace: instructionSeat.podNamespace, instanceKey: input.instanceKey!, endpoint: `http://127.0.0.1:${config.daemonPort}` } } : plan
    return plans.add(consoleTarget ? { ...scoped, console: consoleTarget.scope } : scoped, fingerprint(config, target))
  })
  orca.panels.handle('setup.execute', async input => {
    const config = await getConfig()
    const target = await workspace(input.workspaceId)
    // Never accept a shell command supplied by the panel: consume the exact server-side plan.
    const plan = plans.consume(input.planId, fingerprint(config, target))
    if (plan.pod) await assertPodInstance(config, plan.pod.instanceKey)
    if (plan.action === 'console') {
      if (!plan.console) throw fail('console_changed', 'The TUI review is not instance-bound. Prepare a new review.')
      await recheckTuiConsole(config, await discover({ ...config, provider: 'none' }), plan.console)
    }
    if (plan.action === 'send-instruction') {
      const target = plan.instruction
      const current = target && (await listInstructionSeats(config, await discover(config))).find((seat: Seat) => seat.key === target.key)
      if (!canInstruct(current) || current.session !== target?.session || current.runtime !== target?.runtime || (plan.pod && podKeyOf(current) !== plan.pod.key)) throw fail('seat_unavailable', 'The reviewed agent is no longer available and idle. No result terminal was created; refresh before preparing another instruction.')
    }
    if (plan.seatLaunch || plan.queueTask) {
      const reviewed = plan.seatLaunch || plan.queueTask
      const current = (await listInstructionSeats(config, await discover(config))).find((seat: Seat) => seat.key === reviewed.key)
      if (plan.pod && podKeyOf(current) !== plan.pod.key) throw fail('pod_changed', 'The selected seat changed pods or is unavailable. Refresh before another review; no terminal was created.')
      if (plan.seatLaunch) {
        if (current?.status === 'running') return { noOp: true as const, detail: 'OpenRig reports the seat is already running and was left unchanged. No launch command or result terminal was created.' }
        if (input.acceptStartupRisk !== true) throw fail('startup_consent_required', 'Acknowledge the unverified native startup settings before starting a seat')
        if (!canStartSeat(current) || !sameSeatDefinition(current, plan.seatLaunch)) throw fail('seat_unavailable', 'The reviewed seat definition or availability changed. Refresh and review again; nothing was launched.')
      } else if (!canQueueTask(current) || current.session !== plan.queueTask.destination || current.runtime !== plan.queueTask.runtime) throw fail('seat_unavailable', 'The reviewed task recipient changed. No queue create was requested.')
    }
    if (plan.launchReview) await stageLaunchProgram(plan.launchReview)
    if (plan.queueTask) {
      const task = plan.queueTask
      await stageTaskBody(config.root, task)
      // Save intent before the possibly ambiguous terminal operation, so read-only reconciliation remains available.
      await orca.storage.set(`task:${task.id}`, { id: task.id, destination: task.destination, summary: task.summary, bodyHash: taskHash(task.body), source: 'orca-gui@external', config: JSON.stringify(config) })
    }
    const staged = await stageAction(config.root, plan.command)
    const result = await createTerminalView(orca, target, plan.title, staged.command)
    const accepted = plan.queueTask ? { ...result, task: { id: plan.queueTask.id, destination: plan.queueTask.destination, registration: 'unverified' as const, state: 'unknown', detail: 'A create request was opened. Check registration before retrying; a task ID is not proof of persistence or completion.' } } : result
    const receipt = plan.example && plan.action !== 'stop-example'
      ? await persistTerminalReceipt(orca.storage, `example:${plan.example.id}`, plan.example, accepted) : accepted
    return receipt
  })
  orca.panels.handle('task.check', async input => {
    if (!validTaskId(input.id)) throw fail('task_unowned', 'Choose a task ID prepared by this plugin')
    const record = await orca.storage.get(`task:${input.id}`)
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.id !== input.id || typeof record.config !== 'string' || typeof record.destination !== 'string' || typeof record.summary !== 'string' || typeof record.bodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.bodyHash) || (record.source !== undefined && record.source !== 'orca-gui@external')) throw fail('task_unowned', 'No saved request exists for this ID; inspect the original result terminal before any retry')
    const config = await getConfig()
    return checkTask(config, await discover(config), record)
  })
  orca.panels.handle('terminal.reveal', async input => {
    if (typeof input.terminalId !== 'string' || !/^term_[a-zA-Z0-9-]+$/.test(input.terminalId) || input.terminalId.length > 200) throw fail('terminal_unowned', 'Choose a terminal created by this plugin')
    const owned = await orca.storage.get(`terminal:${input.terminalId}`)
    if (!owned || typeof owned !== 'object' || Array.isArray(owned) || owned.terminalId !== input.terminalId || typeof owned.workspaceId !== 'string') throw fail('terminal_unowned', 'No saved receipt for this terminal. Use its displayed recovery command; do not repeat the original action.')
    await workspace(owned.workspaceId)
    return revealTerminal(owned)
  })
  orca.panels.handle('examples.list', async () => {
    const config = await getConfig()
    const keys = (await orca.storage.keys()).filter(key => /^example:[a-f0-9]{12}$/.test(key))
    const records = await Promise.all(keys.map(key => orca.storage.get(key)))
    return { examples: records.filter(record => record && typeof record === 'object' && !Array.isArray(record) && record.configRoot === config.root).map(record => record as unknown as ExampleRecord) }
  })
  orca.panels.handle('seats.list', async () => {
    const config = await getConfig()
    return { seats: await listSeats(config, await discover(config)) }
  })
  orca.panels.handle('seat.attach', async input => {
    const target = await workspace(input.workspaceId)
    const config = await getConfig()
    if (input.podKey !== undefined) await assertPodInstance(config, input.instanceKey)
    const snapshot = await discover(config)
    const seat = (await listSeats(config, snapshot)).find((s: Seat) => s.key === input.key)
    if (input.podKey !== undefined && (typeof input.podKey !== 'string' || podKeyOf(seat) !== input.podKey)) throw fail('pod_changed', 'The seat is not in the selected pod. No view was opened.')
    if (!seat || seat.status !== 'running') throw fail('seat_unavailable', 'Seat is no longer running. Refresh and recover it in OpenRig; it was not relaunched automatically.')
    const rig = await rigInvocation(snapshot.tools.rig!, snapshot.tools.node!)
    // Ask OpenRig to resolve its own tmux server. Never execute tmuxAttachCommand from JSON.
    const args = [...rig.args, 'terminal', 'attach', ...(input.readOnly ? ['--read-only'] : []), '--', seat.session]
    const command = shellCommand('/bin/sh', ['-c', `${commandEnvironment(config, snapshot)} exec ${shellCommand(rig.file, args)}`])
    const staged = await stageAction(config.root, command)
    const result = await createTerminalView(orca, target, `${seat.rigName} · ${seat.logicalId}`, staged.command)
    // Persist logical identity, not tmux pane names. A new view can rebind after a seat restart.
    return persistTerminalReceipt(orca.storage, `view:${JSON.stringify([target.id, seat.rigId, seat.logicalId])}`, { terminalId: result.terminalId, session: seat.session, openedAt: Date.now() }, result)
  })
}
