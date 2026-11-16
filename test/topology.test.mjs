import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTopology, topologyMermaid, mermaidLabel, topologyNodeId, SAMPLE_TOPOLOGY } from '../src/visualizer/topology.mjs'
import { exampleBundle } from '../src/examples.mjs'
import { startTopologyPreview } from '../scripts/preview-topology.mjs'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

test('YAML projects declared pods, agent metadata and directed relationships without live status', () => {
  const result = parseTopology(SAMPLE_TOPOLOGY)
  assert.equal(result.pods.length, 1); assert.equal(result.nodes.length, 3); assert.equal(result.edges.length, 3)
  assert.equal(result.nodes[0].model, 'Not declared here')
  assert.equal('status' in result.nodes[0], false)
  assert.equal(result.edges[0].kind, 'delegates_to')
  assert.match(topologyMermaid(result), /flowchart LR\nsubgraph pod_0\["Product team"\]\ndirection LR/)
  assert.match(topologyMermaid(result, 'TB'), /direction TB/)
  assert.throws(() => topologyMermaid(result, 'invalid'), /direction/)
})
test('edgeless rosters use invisible layout ranks without inventing relationship edges', () => {
  const topology = parseTopology(SAMPLE_TOPOLOGY)
  assert.equal(topologyMermaid(topology).includes('~~~'), false, 'Do not alter declared relationship flow')
  topology.edges = []
  for (const direction of ['LR', 'TB']) {
    const source = topologyMermaid(topology, direction)
    assert.ok(source.startsWith(`flowchart ${direction}\n`))
    assert.match(source, /agent_0 ~~~ agent_1\nagent_1 ~~~ agent_2/)
    assert.equal(source.includes('-->'), false)
    assert.equal(topology.edges.length, 0)
  }
})
test('Mermaid-prefixed node IDs resolve only to generated agent identities', () => {
  assert.equal(topologyNodeId('rig_diagram_1-flowchart-agent_0-0'), 'agent_0')
  assert.equal(topologyNodeId('flowchart-agent_12-40'), 'agent_12')
  assert.equal(topologyNodeId('unrelated-agent_0'), null)
})
test('existing generated OpenRig templates are visualized without executing startup or resolving paths', () => {
  for (const kind of ['demo', 'claude', 'codex']) {
    const fixture = exampleBundle(kind, '0123456789ab', '/fixture/never-read')
    const result = parseTopology(fixture.files['rig.yaml'])
    assert.equal(result.nodes.length, 2); assert.equal(result.edges.length, 1)
    assert.equal(JSON.stringify(result).includes('printf'), false)
    assert.equal(JSON.stringify(result).includes('/fixture/never-read'), false)
  }
})
test('ID-keyed mappings and explicit cross-pod endpoints work; ambiguous names are not guessed', () => {
  const yaml = `name: Fixture\npods:\n  a:\n    members:\n      worker: {runtime: pi}\n  b:\n    members:\n      worker: {runtime: codex}\nedges:\n  - {from: a.worker, to: b.worker, kind: delegates_to}\n  - {from: worker, to: b.worker, kind: delegates_to}\n`
  const result = parseTopology(yaml)
  assert.equal(result.nodes.length, 2); assert.equal(result.edges.length, 1)
  assert.ok(result.warnings.some(s => s.includes('ambiguous')))
  assert.equal(result.edges[0].from, 'agent_0'); assert.equal(result.edges[0].to, 'agent_1')
})
test('aliases, custom tags, duplicate keys and extra YAML documents are rejected without echoing source', () => {
  for (const source of ['pods: &a [*a]', 'pods: !private SENSITIVE_FIXTURE', 'name: a\nname: b\npods: []', 'pods: []\n---\npods: []', 'pods: [SENSITIVE_FIXTURE']) {
    assert.throws(() => parseTopology(source), error => { assert.equal(error.message.includes('SENSITIVE_FIXTURE'), false); return true })
  }
})
test('YAML input, nesting, topology size and identifiers have explicit bounds', () => {
  assert.throws(() => parseTopology(' '.repeat(262145) + 'pods: []'), /256 KiB/)
  assert.throws(() => parseTopology('pods: ' + '['.repeat(40) + ']'.repeat(40)), /nesting/)
  assert.throws(() => parseTopology('pods: []'), /1 and 16/)
  assert.throws(() => parseTopology('pods: [{id: dev, members: []}]'), /no members/)
  const members = Array.from({ length: 81 }, (_, i) => `{id: agent${i}}`).join(',')
  assert.throws(() => parseTopology(`pods: [{id: dev, members: [${members}]}]`), /80 agents/)
  assert.throws(() => parseTopology('pods: [{id: dev, members: [{id: a}, {id: a}]}]'), /unique/)
})
test('unknown fields and YAML prototype-shaped keys do not leak into the projection or mutate objects', () => {
  const result = parseTopology('environment: {API_KEY: SENSITIVE_FIXTURE}\npods:\n  __proto__:\n    members:\n      constructor: {runtime: pi, secret: SENSITIVE_FIXTURE}\n')
  assert.equal(result.nodes[0].id, 'constructor')
  assert.equal(JSON.stringify(result).includes('SENSITIVE_FIXTURE'), false)
  assert.equal(Object.prototype.API_KEY, undefined)
})
test('labels cannot introduce Mermaid directives, HTML, Markdown math, links or executable syntax', () => {
  const label = 'x"\\<script> %%{init:bad}%% $$math$$ #quot; `code` | &'
  const safe = mermaidLabel(label)
  assert.equal(/["\\<>%$#`|{}&]/.test(safe), false)
  const result = parseTopology(SAMPLE_TOPOLOGY)
  result.pods[0].label = label; result.nodes[0].id = label; result.edges[0].kind = label
  const source = topologyMermaid(result)
  assert.equal(source.includes('<script>'), false); assert.equal(source.includes('%%{'), false)
  assert.equal(source.split('\n').some(line => line.startsWith('click ')), false)
  assert.equal((source.match(/subgraph /g) || []).length, 1)
})
test('generated assets are pinned, current, licensed, integrity-listed and standalone', async () => {
  const directory = path.join(root, 'src', 'visualizer')
  const assets = JSON.parse(await readFile(path.join(directory, 'assets.json'), 'utf8'))
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  for (const [name, info] of Object.entries(assets.dependencies)) assert.equal(info.version, pkg.devDependencies[name])
  for (const [file, expected] of Object.entries(assets.inputs)) assert.equal(hash(await readFile(path.join(root, file))), expected, `Rebuild assets after changing ${file}`)
  for (const file of assets.files) {
    assert.ok(!file.path.includes('..') && !file.path.endsWith('.map'))
    if (file.path.startsWith('licenses/')) assert.equal(/\.(?:[cm]?js|ts|sh|py|bat|ps1|exe)$/i.test(file.path), false, 'Notices must not copy upstream maintenance scripts')
    const bytes = await readFile(path.join(directory, file.path))
    assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256)
  }
  assert.ok(assets.files.some(file => file.path === 'licenses/mermaid@12.3.0/LICENSE'))
  assert.ok(assets.files.some(file => file.path === 'licenses/packages.json'))
  assert.ok(assets.files.reduce((sum, file) => sum + file.bytes, 0) < 10 * 1024 * 1024)
  const client = await readFile(path.join(root, 'src', 'topology-client.mjs'), 'utf8')
  assert.equal(/plugin\.request|localStorage|sessionStorage|fetch\(/.test(client), false)
  assert.match(client, /securityLevel: 'strict'/); assert.match(client, /DOMPurify\.sanitize/)
})
test('the unified HTML contains exactly three internal tabs and embeds topology without another frame', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'orca-plugin.json'), 'utf8'))
  assert.deepEqual(manifest.contributes.panels, [{ id: 'openrig', title: 'OpenRig for Orca', icon: 'layers', entry: 'src/visualizer/plugin.html', ui: 'html' }])
  const html = await readFile(path.join(root, 'src', 'visualizer', 'plugin.html'), 'utf8')
  assert.equal((html.match(/role="tab"/g) || []).length, 3)
  assert.equal((html.match(/role="tabpanel"/g) || []).length, 3)
  assert.equal((html.match(/id="yaml-source"/g) || []).length, 1)
  assert.ok(html.indexOf('id="yaml-source"') > html.indexOf('id="dashboard-view"'))
  assert.ok(html.indexOf('id="instruction-text"') > html.indexOf('id="messages-view"'))
  assert.ok(html.indexOf('id="task-body"') < html.indexOf('id="messages-view"'))
  assert.ok(html.indexOf('id="messages-destination"') > html.indexOf('id="instruction-text"'))
  assert.match(html, /aria-describedby="message-send-status"/)
  assert.equal(/<iframe|TOPOLOGY_CONTENT/.test(html), false)
  assert.match(html, /src="\.\/workspace\.mjs"/)
})
test('loopback preview serves only static allowlisted assets and rejects uploads or private paths', async () => {
  const { server, url } = await startTopologyPreview()
  try {
    const page = await fetch(url)
    assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /connect-src 'none'/)
    const html = await page.text()
    assert.match(html, /OpenRig Preparation/)
    assert.match(html, /OpenRig Dashboard/)
    assert.equal((await fetch(url + 'visualizer/app.mjs')).status, 200)
    for (const file of ['package.json', 'src/worker.ts', '%2e%2e%2fpackage.json', 'visualizer/../../package.json']) assert.equal((await fetch(url + file)).status, 404)
    assert.equal((await fetch(url, { method: 'POST', body: 'private input' })).status, 405)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
