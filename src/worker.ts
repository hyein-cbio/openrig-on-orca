import type { OrcaWorkerApi } from 'orca/worker'
import { buildPlan, fingerprint, PlanStore } from './plans.mjs'
import { stageAction } from './action-files.mjs'
import { stageLaunchProgram } from './launch-review.mjs'
import { persistTerminalReceipt } from './terminal-receipt.mjs'
import { commandEnvironment, configFrom, discover, fail, listSeats, rigInvocation, shellCommand } from './runtime.mjs'
import type { Config, ExampleRecord, Seat, Workspace } from './protocol'

const CONFIG = 'config.v1'

export default function activate(orca: OrcaWorkerApi): void {
  const plans = new PlanStore()
  const getConfig = async (): Promise<Config> => configFrom((await orca.storage.get(CONFIG)) || {})
  async function workspaces(): Promise<Workspace[]> {
    const result = await orca.host.call('workspace.list')
    if (result.truncated) throw fail('workspace_list_truncated', 'Workspace list is incomplete; narrow your Orca workspace inventory before using this plugin')
    return result.workspaces.map(w => ({ id: w.id, name: w.name, path: w.path, hostId: w.hostId || null }))
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
    return { config, snapshot, workspaces: spaces }
  }
  orca.panels.handle('environment.scan', state)
  orca.panels.handle('config.save', async input => {
    const config = configFrom(input)
    await orca.storage.set(CONFIG, config)
    return state()
  })
  orca.panels.handle('setup.prepare', async (input, { signal }) => {
    const config = await getConfig()
    const target = await workspace(input.workspaceId)
    const snapshot = await discover(config)
    let example
    if (['example-demo', 'stop-example', 'launch-example', 'launch-team'].includes(input.action)) await listSeats(config, snapshot)
    if (input.action === 'stop-example' || input.action === 'launch-example') {
      if (!/^[a-f0-9]{12}$/.test(input.exampleId || '')) throw fail('example_unowned', 'Choose a recorded demo')
      example = await orca.storage.get(`example:${input.exampleId}`)
    }
    const plan = await buildPlan(input.action, config, snapshot, target, { spec: input.spec, example }, { signal })
    return plans.add(plan, fingerprint(config, target))
  })
  orca.panels.handle('setup.execute', async input => {
    const config = await getConfig()
    const target = await workspace(input.workspaceId)
    // Never accept a shell command supplied by the panel: consume the exact server-side plan.
    const plan = plans.consume(input.planId, fingerprint(config, target))
    if (plan.launchReview) await stageLaunchProgram(plan.launchReview)
    const staged = await stageAction(config.root, plan.command)
    const result = await orca.host.call('terminal.create', { workspaceId: target.id, title: plan.title, command: staged.command })
    const receipt = plan.example && plan.action !== 'stop-example'
      ? await persistTerminalReceipt(orca.storage, `example:${plan.example.id}`, plan.example, result) : result
    return receipt
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
    const snapshot = await discover(config)
    const seat = (await listSeats(config, snapshot)).find((s: Seat) => s.key === input.key)
    if (!seat || seat.status !== 'running') throw fail('seat_unavailable', 'Seat is no longer running. Refresh and recover it in OpenRig; it was not relaunched automatically.')
    const rig = await rigInvocation(snapshot.tools.rig!, snapshot.tools.node!)
    // Ask OpenRig to resolve its own tmux server. Never execute tmuxAttachCommand from JSON.
    const args = [...rig.args, 'terminal', 'attach', ...(input.readOnly ? ['--read-only'] : []), '--', seat.session]
    const command = shellCommand('/bin/sh', ['-c', `${commandEnvironment(config, snapshot)} exec ${shellCommand(rig.file, args)}`])
    const staged = await stageAction(config.root, command)
    const result = await orca.host.call('terminal.create', { workspaceId: target.id, title: `${seat.rigName} · ${seat.logicalId}`, command: staged.command })
    // Persist logical identity, not tmux pane names. A new view can rebind after a seat restart.
    return persistTerminalReceipt(orca.storage, `view:${JSON.stringify([target.id, seat.rigId, seat.logicalId])}`, { terminalId: result.terminalId, session: seat.session, openedAt: Date.now() }, result)
  })
}
