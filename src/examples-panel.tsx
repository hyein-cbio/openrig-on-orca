import { atom, Badge, Box, Button, Callout, Card, Code, CodeView, Heading, plugin, read, Row, Select, set, Stack, Text, type PanelContext } from 'orca'
import { EXAMPLE_STEPS } from './example-story.mjs'
import type { ExampleRecord, Plan, Seat, State } from './protocol'

const step = atom(0)
const state = atom<State | null>(null)
const workspace = atom('')
const records = atom<ExampleRecord[]>([])
const seats = atom<Seat[]>([])
const pending = atom<Plan | null>(null)
const busy = atom(false)
const error = atom('')
const notice = atom('')

async function perform(fn: () => Promise<void>) {
  if (read(busy)) return
  set(busy, true); set(error, ''); set(notice, '')
  try { await fn() } catch (e) { set(error, e instanceof Error ? e.message : String(e)) }
  finally { set(busy, false) }
}
async function reload() {
  await perform(async () => {
    const [next, examples] = await Promise.all([plugin.request('environment.scan'), plugin.request('examples.list')])
    set(state, next); set(records, examples.examples); set(pending, null); set(seats, [])
    if (!next.workspaces.some(w => w.id === read(workspace))) set(workspace, '')
  })
}
async function prepare(action: string, exampleId?: string) {
  await perform(async () => {
    set(pending, null)
    set(pending, await plugin.request('setup.prepare', { action, workspaceId: read(workspace), ...(exampleId ? { exampleId } : {}) }, { timeoutMs: 120000 }))
  })
}
async function confirm() {
  await perform(async () => {
    const plan = read(pending)
    if (!plan) return
    set(pending, null)
    const result = await plugin.request('setup.execute', { planId: plan.id, workspaceId: read(workspace) })
    set(notice, `Opened terminal ${result.terminalId}. Inspect its result, then refresh. A created terminal is not proof of a running team. ${result.warning || ''}`)
    try { set(records, (await plugin.request('examples.list')).examples) }
    catch { set(error, 'The terminal was already opened, but refreshing examples failed. Do not repeat the action; inspect its terminal and recheck the environment.') }
  })
}
async function refresh() {
  await perform(async () => { set(seats, []); set(seats, (await plugin.request('seats.list')).seats) })
}
async function attach(key: string) {
  await perform(async () => {
    const result = await plugin.request('seat.attach', { key, workspaceId: read(workspace), readOnly: true })
    set(notice, `Opened a read-only seat view. Closing the tab only detaches; it does not stop the team. ${result.warning || ''}`)
  })
}
export function setup(ctx: PanelContext) {
  void Promise.all([plugin.request('environment.scan', undefined, { signal: ctx.signal }), plugin.request('examples.list', undefined, { signal: ctx.signal })])
    .then(([next, examples]) => { if (!ctx.signal.aborted) { set(state, next); set(records, examples.examples) } })
    .catch(e => { if (!ctx.signal.aborted) set(error, e instanceof Error ? e.message : String(e)) })
}

export default function ExampleWindow() {
  const current = EXAMPLE_STEPS[read(step)]
  const env = read(state)
  const locked = read(busy) || !read(workspace)
  const plan = read(pending)
  return <Box padding="md" gap="md">
    <Row justify="between" wrap><Heading>Example Window</Heading><Badge tone="accent">Build & Review</Badge></Row>
    <Text>One bounded task, two distinct roles. Learn the topology before starting agents.</Text>
    <Card title="Topology" description="The arrows describe intended work handoffs, not proof that a task was executed.">
      <Stack gap="sm">
        <CodeView label="Build and review topology" code={'You → Builder → Reviewer\n        ↑           │\n        └─ feedback ┘\nYou ← result + tests + review'} wrap />
        <Row gap="sm" wrap><Badge>Builder · implement and test</Badge><Badge>Reviewer · inspect and report</Badge></Row>
        <Text size="xs" muted>Reviewer no-edit behavior is role guidance, not an OS permission guarantee.</Text>
      </Stack>
    </Card>
    <Card title="Walk through the workflow" description="SIMULATION ONLY — prerecorded explanation, no AI, no commands and no model charges.">
      <Stack gap="sm">
        <Text muted size="xs">Step {read(step) + 1} of {EXAMPLE_STEPS.length}</Text>
        <Heading level={3}>{current.title}</Heading><Badge>{current.speaker}</Badge><Text>{current.text}</Text>
        <Row gap="xs" wrap>
          <Button size="sm" variant="outline" disabled={read(step) === 0} onPress={() => set(step, read(step) - 1)}>Previous step</Button>
          <Button size="sm" disabled={read(step) === EXAMPLE_STEPS.length - 1} onPress={() => set(step, read(step) + 1)}>Next step</Button>
          <Button size="sm" variant="ghost" onPress={() => set(step, 0)}>Restart walkthrough</Button>
        </Row>
      </Stack>
    </Card>
    {read(error) && <Callout tone="danger" title="Example action needs attention"><Text>{read(error)}</Text></Callout>}
    {read(notice) && <Callout tone="success" title="Request accepted"><Text>{read(notice)}</Text></Callout>}
    <Select label="Example destination workspace" value={read(workspace)} placeholder="Choose a local Orca workspace" disabled={read(busy)}
      options={(env?.workspaces || []).filter(w => !w.hostId || w.hostId === 'local').map(w => ({ value: w.id, label: w.name }))}
      onChange={value => { set(workspace, value); set(pending, null) }} />
    <Button size="sm" variant="ghost" disabled={read(busy)} onPress={reload}>Recheck example environment</Button>
    <Card title="Try real terminals, without AI" description="Creates two actual tmux terminal seats showing prerecorded Builder and Reviewer descriptions. It performs no work handoff.">
      <Stack gap="sm"><Badge tone="warning">Terminal simulation · no login</Badge>
        <Text size="xs">First install OpenRig/tmux and start the no-agent daemon in the OpenRig Setup panel. New demo files stay in the plugin’s private directory.</Text>
        <Button disabled={locked || !env?.snapshot.installed} onPress={() => prepare('example-demo')}>Prepare terminal demo</Button>
      </Stack>
    </Card>
    <Card title="Use this topology with real agents" description="Creates a small clamp() project with a deliberate lower-bound defect, two agent roles and a local RigSpec.">
      <Stack gap="sm">
        <Text size="xs">Each template uses a single provider for both seats. Creating it does not sign in or start an agent. A frozen review, acceptance of unverified native settings, and LAUNCH confirmation are required to run it.</Text>
        <Row gap="xs" wrap>
          <Button size="sm" variant="outline" disabled={locked || !env?.snapshot.tools.node} onPress={() => prepare('example-claude')}>Prepare Claude template</Button>
          <Button size="sm" variant="outline" disabled={locked || !env?.snapshot.tools.node} onPress={() => prepare('example-codex')}>Prepare Codex template</Button>
        </Row>
      </Stack>
    </Card>
    {plan && <Card title={`Review · ${plan.title}`} description="No installation or launch has run. Launch preparation may have created a private frozen bundle. This plan expires after five minutes.">
      <Stack gap="sm">
        {plan.writes.map((text, i) => <Text key={`write-${i}`} size="xs">Writes: {text}</Text>)}
        {plan.warnings.map((text, i) => <Text key={`warn-${i}`} size="xs" tone="warning">{text}</Text>)}
        {plan.launchReview && <CodeView label="Frozen launch declarations and unverified settings" code={JSON.stringify(plan.launchReview.display, null, 2)} language="json" wrap />}
        <CodeView label="Exact example command" code={plan.command} language="shell" wrap />
        <Row gap="xs" wrap><Button disabled={read(busy)} onPress={confirm}>Confirm example action</Button><Button variant="ghost" onPress={() => set(pending, null)}>Cancel example action</Button></Row>
      </Stack>
    </Card>}
    <Card title="Your examples" description="Records mean a command was issued. Refresh to read actual seat state; unknown or absent is not success.">
      <Stack gap="sm">
        <Button size="sm" disabled={read(busy) || !env?.snapshot.installed} onPress={refresh}>Refresh example seats</Button>
        {!read(records).length && <Text muted>No examples created in this OpenRig instance yet.</Text>}
        {read(records).map(record => <Card key={record.id} title={record.kind === 'demo' ? 'Terminal demo · simulation only' : `${record.kind} · real-agent template`}>
          <Stack gap="sm"><Code>{record.specPath}</Code>
            {read(seats).filter(s => s.rigName === record.rigName).map(seat => <Row key={seat.key} justify="between" wrap>
              <Text>{seat.logicalId} · {seat.status}</Text><Button size="sm" disabled={locked || seat.status !== 'running'} onPress={() => attach(seat.key)}>Open {seat.logicalId} view</Button>
            </Row>)}
            {record.kind === 'demo'
              ? <Button size="sm" tone="warning" variant="outline" disabled={locked} onPress={() => prepare('stop-example', record.id)}>Prepare stop demo</Button>
              : <Button size="sm" disabled={locked || !env?.snapshot.ready} onPress={() => prepare('launch-example', record.id)}>Preview real team launch</Button>}
          </Stack>
        </Card>)}
      </Stack>
    </Card>
    <Callout title="View lifetime is not team lifetime"><Text>Orca owns the view. OpenRig owns the team. tmux stays required. Closing this example panel, or a seat tab, never means stopping a team.</Text></Callout>
  </Box>
}
