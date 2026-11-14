import {
  atom, Badge, Box, Button, Callout, Card, Checkbox, Code, CodeView, Collapsible,
  EmptyState, Heading, Input, Link, plugin, read, Row, Select, set, Spinner, Stack,
  Tab, Tabs, Text, update, type PanelContext
} from 'orca'
import type { Config, Plan, Seat, State, TerminalReceipt } from './protocol'
import { TerminalStatus } from './terminal-status'
import { workspaceLabel, workspaceOptions } from './workspace-labels.mjs'

const state = atom<State | null>(null)
const draft = atom<Config | null>(null)
const tab = atom('setup')
const workspaceId = atom('')
const busy = atom(false)
const error = atom('')
const notice = atom('')
const receipt = atom<TerminalReceipt | null>(null)
const plan = atom<Plan | null>(null)
const seats = atom<Seat[] | null>(null)
const readOnly = atom(true)
const spec = atom('')

async function perform(work: () => Promise<void>) {
  if (read(busy)) return
  set(busy, true)
  set(error, '')
  set(notice, '')
  try { await work() } catch (e) { set(error, e instanceof Error ? e.message : String(e)) }
  finally { set(busy, false) }
}

function apply(next: State) {
  set(state, next)
  set(draft, next.config)
  if (!next.workspaces.some(w => w.id === read(workspaceId))) set(workspaceId, '')
}

async function scan() {
  await perform(async () => {
    apply(await plugin.request('environment.scan'))
    set(plan, null)
    set(seats, null)
  })
}

function change(key: keyof Config, value: string) {
  update(draft, current => current ? { ...current, [key]: value } : current)
  set(plan, null)
}

function dirty() { return JSON.stringify(read(draft)) !== JSON.stringify(read(state)?.config) }

async function save() {
  await perform(async () => {
    const config = read(draft)
    if (!config) return
    apply(await plugin.request('config.save', config))
    set(plan, null)
    set(seats, null)
    set(notice, 'Configuration saved. No software was installed or launched.')
  })
}

async function prepare(action: string) {
  await perform(async () => {
    set(plan, null)
    set(plan, await plugin.request('setup.prepare', { action, workspaceId: read(workspaceId), spec: read(spec) }, { timeoutMs: 120000 }))
  })
}

async function execute() {
  await perform(async () => {
    const pending = read(plan)
    if (!pending) return
    set(plan, null)
    const result = await plugin.request('setup.execute', { planId: pending.id, workspaceId: read(workspaceId) })
    set(receipt, result)
  })
}

async function reveal() {
  await perform(async () => {
    const current = read(receipt)
    if (current) set(receipt, await plugin.request('terminal.reveal', { terminalId: current.terminalId }))
  })
}

async function refreshSeats() {
  await perform(async () => {
    set(seats, null)
    set(seats, (await plugin.request('seats.list')).seats)
  })
}

async function attach(key: string) {
  await perform(async () => {
    const result = await plugin.request('seat.attach', { key, workspaceId: read(workspaceId), readOnly: read(readOnly) })
    set(receipt, result)
    set(notice, 'Closing the view only detaches; the seat stays running. Recover the existing terminal instead of opening another view.')
  })
}

export function setup(ctx: PanelContext) {
  set(busy, true)
  void plugin.request('environment.scan', undefined, { signal: ctx.signal }).then(next => {
    if (!ctx.signal.aborted) apply(next)
  }).catch(e => {
    if (!ctx.signal.aborted) set(error, e instanceof Error ? e.message : String(e))
  }).finally(() => { if (!ctx.signal.aborted) set(busy, false) })
}

const fieldLabels: [keyof Config, string, string][] = [
  ['root', 'Plugin data directory', '/absolute/path/openrig-for-orca'],
  ['daemonPort', 'Local daemon port', '43811 — loopback only; choose an unused port'],
  ['nodePath', 'Node executable', 'Automatic: agent-associated Node, PATH, then host runtime'],
  ['npmPath', 'npm executable', 'Automatic: selected Node’s PATH'],
  ['rigPath', 'OpenRig executable', 'Automatic: private runtime, then PATH'],
  ['tmuxPath', 'tmux executable', 'Automatic: PATH and standard locations'],
  ['extraPath', 'Additional executable directories', 'Absolute directories separated by the OS PATH delimiter'],
  ['homePath', 'Effective HOME override', 'Optional; use an isolated home for sandbox tests'],
  ['codexHome', 'Existing CODEX_HOME', 'Optional existing account configuration directory'],
  ['claudeConfigDir', 'Existing CLAUDE_CONFIG_DIR', 'Optional existing account configuration directory']
]

function Action({ action, children, disabled = false }: { action: string; children: string | string[]; disabled?: boolean }) {
  return <Button size="sm" variant="outline" disabled={read(busy) || dirty() || !read(workspaceId) || disabled} onPress={() => prepare(action)}>{children}</Button>
}

export default function Panel() {
  const current = read(state)
  const config = read(draft)
  const pending = read(plan)
  const snapshot = current?.snapshot
  const isDirty = dirty()
  const waiting = read(busy)
  return (
    <Box padding="md" gap="md">
      <Row justify="between" wrap>
        <Stack gap="xs"><Heading>OpenRig for Orca</Heading><Text muted size="xs">Persistent teams. Native Orca terminals.</Text></Stack>
        <Badge tone={snapshot?.ready ? 'success' : 'neutral'}>tmux-backed</Badge>
      </Row>
      {read(error) && <Callout tone="danger" title="Action needs attention"><Text>{read(error)}</Text></Callout>}
      {read(notice) && <Callout tone="success" title="Request accepted"><Text>{read(notice)}</Text></Callout>}
      {!pending && read(receipt) && <TerminalStatus receipt={read(receipt)!} busy={waiting} onReveal={reveal} />}
      {!pending && snapshot?.installed && <Callout title="Daemon connection" tone={current?.daemon?.status === 'reachable' ? 'neutral' : 'warning'}>
        <Text>Daemon: {current?.daemon?.status || 'unavailable'}. {current?.daemon?.detail || 'Recheck environment to verify this instance.'}</Text>
      </Callout>}
      {waiting && <Spinner label="Checking environment or preparing your request" />}
      {!current || !config || !snapshot ? (
        <EmptyState icon="layers" title="Discovering your tools" description="Read-only checks. Nothing is installed, signed in or launched automatically."><Button disabled={waiting} onPress={scan}>Retry environment check</Button></EmptyState>
      ) : (
        <Stack gap="md">
          <Select label="Destination Orca workspace" value={read(workspaceId)} placeholder="Choose a local workspace" disabled={waiting}
            options={workspaceOptions(current.workspaces)}
            onChange={value => { set(workspaceId, value); set(plan, null) }} />
          {!current.workspaces.length && <Callout tone="warning" title="No workspace available"><Text>Open a local project or folder in Orca first.</Text></Callout>}
          {!read(workspaceId) && <Callout title="Choose a destination first" tone="warning"><Text>Select a local workspace above to enable action previews. Previewing does not run the command.</Text></Callout>}
          {pending && <Card title={`Review · ${pending.title}`} description="No installation or launch has run. Launch preparation may have created a private frozen bundle. This one-use plan expires in five minutes.">
            <Stack gap="sm">
              <Text>Destination: {workspaceLabel(current.workspaces.find(w => w.id === pending.workspaceId))} · {current.workspaces.find(w => w.id === pending.workspaceId)?.path}</Text>
              <Link href={pending.source}>Official source / installation guide</Link>
              <Heading level={3}>Writes and effects</Heading>
              {pending.writes.map((value, index) => <Text key={`write-${index}`} size="xs">{value}</Text>)}
              {pending.warnings.map((value, index) => <Text key={`warning-${index}`} size="xs" tone="warning">{value}</Text>)}
              {pending.launchReview && <CodeView label="Frozen launch declarations and unverified settings" code={JSON.stringify(pending.launchReview.display, null, 2)} language="json" wrap />}
              <CodeView label="Exact command" code={pending.command} language="shell" wrap />
              <Row gap="xs" wrap><Button disabled={waiting || isDirty} onPress={execute}>Confirm and open in Orca terminal</Button><Button variant="ghost" disabled={waiting} onPress={() => set(plan, null)}>Cancel plan</Button></Row>
            </Stack>
          </Card>}
          <Tabs label="OpenRig sections" value={read(tab)} onChange={value => { set(tab, value); set(plan, null) }}>
            <Tab value="setup" label="Setup" icon="wrench">
              {!pending && <Stack gap="md">
                <Card title="1 · Reuse your environment" description="No global install. No extra terminal app.">
                  <Stack gap="sm">
                    <Row justify="between" wrap><Text weight="semibold">{snapshot.stage.replaceAll('-', ' ')}</Text><Button size="sm" variant="ghost" disabled={waiting || isDirty} onPress={scan}>Recheck environment</Button></Row>
                    <Text>Node: {snapshot.tools.node || 'Compatible runtime needed'}</Text>
                    <Text>OpenRig: {snapshot.rigVersion || 'Not installed'}</Text>
                    <Text>tmux: {snapshot.tmuxVersion || 'Required — not available'}</Text>
                    <Text>SQLite: {snapshot.sqlite.status}</Text><Text muted size="xs">{snapshot.sqlite.detail}</Text>
                    <Text muted size="xs">Install buttons prepare a review above these sections. Only confirmation runs the command.</Text>
                    <Row wrap gap="xs">
                      <Action action="install-rig" disabled={!snapshot.tools.node || !snapshot.tools.npm}>Install managed OpenRig</Action>
                      <Action action="install-tmux">Install tmux</Action>
                    </Row>
                    <Row wrap gap="sm"><Link href="https://nodejs.org/en/download">Node setup</Link><Link href="https://github.com/tmux/tmux/wiki/Installing">tmux setup without Homebrew</Link></Row>
                  </Stack>
                </Card>
                <Card title="2 · Choose your coding agent" description="Keep your existing CLI account, or configure an agent later.">
                  <Stack gap="sm">
                    <Select label="Coding agent" value={config.provider} disabled={waiting} options={[
                      { value: 'none', label: 'Later — install without an agent' }, { value: 'claude', label: 'Claude Code' },
                      { value: 'codex', label: 'Codex' }, { value: 'both', label: 'Claude Code + Codex' }
                    ]} onChange={value => change('provider', value)} />
                    <Button size="sm" disabled={waiting || !isDirty} onPress={save}>Save configuration</Button>
                    {snapshot.providers.map(provider => <Text key={provider.provider}>{provider.provider}: {provider.status}</Text>)}
                    {config.provider === 'none' && <Text muted size="xs">Installation can finish without an agent. Team execution stays unavailable until an agent is configured.</Text>}
                    {['claude', 'codex'].filter(p => config.provider === p || config.provider === 'both').map(provider => (
                      <Row key={provider} gap="xs" wrap>
                        <Action action={`install-${provider}`}>Install {provider}</Action>
                        <Action action={`login-${provider}`} disabled={!snapshot.tools[provider]}>Sign in to {provider}</Action>
                      </Row>
                    ))}
                    <Text muted size="xs">Existing CLI login environments can be reused. Orca-managed account export is not available through the plugin API; no credentials are copied.</Text>
                  </Stack>
                </Card>
                <Card title="3 · Connect OpenRig" description="Start only the daemon first. Kernel and agents remain separate choices.">
                  <Stack gap="sm">
                    <Text weight="semibold">Daemon: {current.daemon?.status || 'unavailable'}</Text>
                    <Text size="xs">{current.daemon?.detail || 'Recheck environment to verify this instance.'}</Text>
                    <Text muted size="xs">Order: verify installation → start daemon without agents → inspect its terminal → Recheck environment → open dashboard.</Text>
                    <Row gap="xs" wrap>
                      <Action action="start-daemon" disabled={!snapshot.installed}>Start daemon · no agents</Action>
                      <Action action="console" disabled={!snapshot.installed || current.daemon?.status !== 'reachable'}>Open dashboard</Action>
                    </Row>
                    {snapshot.installed && current.daemon?.status !== 'reachable' && <Text tone="warning" size="xs">Dashboard is disabled until this instance responds. Starting or rechecking the daemon never starts agents automatically.</Text>}
                  </Stack>
                </Card>
              </Stack>}
            </Tab>
            <Tab value="teams" label="Teams" icon="layers">
              {!pending && <Stack gap="md">
                <Card title="Live seats" description="OpenRig owns session lifecycle. Orca owns the view.">
                  <Stack gap="sm">
                    <Row gap="sm" wrap><Button size="sm" disabled={waiting || isDirty || !snapshot.installed} onPress={refreshSeats}>Refresh seats</Button><Checkbox label="Read-only seat view" checked={read(readOnly)} onChange={value => set(readOnly, value)} /></Row>
                    {read(seats) === null ? <Text muted>Refresh to read this OpenRig instance. A failed check never starts or restarts it.</Text> : !read(seats)!.length ? <EmptyState icon="bot" title="No seats yet" description="Launch a configured team, or open the OpenRig dashboard." /> : read(seats)!.map(seat => (
                      <Card key={seat.key} title={`${seat.rigName} / ${seat.logicalId}`}>
                        <Stack gap="xs">
                          <Row gap="xs" wrap><Badge tone={seat.attention ? 'warning' : 'neutral'}>{seat.attention ? 'Needs attention' : seat.status}</Badge><Text size="xs" muted>{seat.runtime} · {seat.activity}</Text></Row>
                          <Code>{seat.session}</Code>
                          <Button size="sm" disabled={waiting || isDirty || !read(workspaceId) || seat.status !== 'running'} onPress={() => attach(seat.key)}>Open seat view</Button>
                        </Stack>
                      </Card>
                    ))}
                  </Stack>
                </Card>
                <Card title="Launch a team" description="Review a frozen bundle, acknowledge unverified native settings, then type LAUNCH.">
                  <Stack gap="sm">
                    <Input label="Absolute local YAML spec" value={read(spec)} disabled={waiting} onChange={value => { set(spec, value); set(plan, null) }} />
                    <Action action="launch-team" disabled={!snapshot.ready}>Preview team launch</Action>
                    <Text muted size="xs">Use an Example Window template, or export a library spec to a local file first. Declared resources are frozen; no automatic model or permission changes.</Text>
                  </Stack>
                </Card>
                <Callout title="Closing a tab is not stopping a seat" icon="info"><Text>A seat view attaches to OpenRig’s tmux session. Close it to detach; use OpenRig for deliberate stop or recovery operations.</Text></Callout>
              </Stack>}
            </Tab>
            <Tab value="paths" label="Paths" icon="folder">
              {!pending && <Stack gap="md">
                <Callout title="Reuse, don’t migrate" icon="link"><Text>Use absolute executable/configuration paths. An empty override uses discovery. The plugin never copies account tokens or edits your shell startup files.</Text></Callout>
                {fieldLabels.map(([key, label, placeholder]) => <Input key={key} label={label} placeholder={placeholder} value={config[key]} maxLength={4096} disabled={waiting} onChange={value => change(key, value)} />)}
                <Button disabled={waiting || !isDirty} onPress={save}>Save paths and recheck</Button>
                <Collapsible title="Discovered executables"><Stack gap="xs">{Object.entries(snapshot.tools).map(([name, value]) => <Text key={name} size="xs">{name}: {value || 'not found'}</Text>)}</Stack></Collapsible>
                <Text muted size="xs">Local macOS/Linux only in this version. Native Windows and remote workspace execution are intentionally refused.</Text>
              </Stack>}
            </Tab>
          </Tabs>
          {isDirty && <Callout tone="warning" title="Unsaved configuration"><Text>Save before preparing commands. Editing paths or agents invalidates the current plan.</Text></Callout>}
          <Text muted size="xs">Required: Orca · plugin · Node · OpenRig · tmux. Herdr, cmux and Ghostty are not required. gh and Docker stay optional.</Text>
        </Stack>
      )}
    </Box>
  )
}
