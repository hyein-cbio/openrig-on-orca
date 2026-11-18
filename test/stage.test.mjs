import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { stagePlugin, verifyVisualizerSources, shipDocumentationPath } from '../scripts/stage.mjs'
import { visualizerInputs } from '../scripts/visualizer-inputs.mjs'

test('shipping stage allowlists runtime files and excludes development/local state', async () => {
  const destination = await mkdtemp(path.join(tmpdir(), 'openrig-package-test-'))
  try {
    await stagePlugin(destination)
    const files = await readdir(destination)
    assert.deepEqual(files.sort(), ['LICENSE', 'README.md', 'SECURITY.md', 'SPEC.md', 'docs', 'orca-plugin.json', 'src'])
    assert.deepEqual((await readdir(path.join(destination, 'src'))).sort(), ['action-files.mjs', 'daemon-start.mjs', 'example-story.mjs', 'examples.mjs', 'launch-review.mjs', 'native-read.mjs', 'pi-html-export.mjs', 'pi-live-session.ts', 'pi-live-tail.ts', 'pi-live.css', 'pi-session-native.mjs', 'plans.mjs', 'plugin.css', 'pod-inventory.mjs', 'pod-relations.mjs', 'pods.mjs', 'protocol.ts', 'report-preview.mjs', 'runtime.mjs', 'seat-instructions.mjs', 'seat-reports.mjs', 'seat-tasks.mjs', 'task-files.mjs', 'terminal-receipt.mjs', 'topology.css', 'topology.html', 'tui-console.mjs', 'user-report-projection.mjs', 'user-reports.mjs', 'visualizer', 'worker.ts', 'workspace-labels.mjs'])
    const manifest = JSON.parse(await readFile(path.join(destination, 'orca-plugin.json'), 'utf8'))
    const license = await readFile(new URL('../LICENSE', import.meta.url), 'utf8')
    assert.equal(await readFile(path.join(destination, 'LICENSE'), 'utf8'), license)
    assert.match(license, /^MIT License/); assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/); assert.match(license, /IN NO EVENT SHALL THE/)
    assert.equal(await readFile(path.join(destination, 'SECURITY.md'), 'utf8'), await readFile(new URL('../SECURITY.md', import.meta.url), 'utf8'))
    assert.equal(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).license, 'MIT')
    assert.equal(JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8')).packages[''].license, 'MIT')
    assert.equal(shipDocumentationPath(path.join('pi-html', 'private', 'report.html')), false)
    assert.equal(shipDocumentationPath(path.join('notes', 'pi-html', 'snapshot.jsonl')), false)
    assert.equal(shipDocumentationPath(path.join('images', 'openrig-dashboard.png')), true)
    assert.equal(manifest.main, 'src/worker.ts')
    assert.equal(manifest.contributes.panels.length, 1)
    assert.equal(manifest.contributes.panels[0].id, 'openrig')
    assert.equal(manifest.contributes.panels[0].entry, 'src/visualizer/plugin.html')
    assert.equal(manifest.contributes.panels[0].ui, 'html')
    assert.match(await readFile(path.join(destination, 'src', 'topology.html'), 'utf8'), /visualizer\/app\.mjs/)
    const assets = JSON.parse(await readFile(path.join(destination, 'src', 'visualizer', 'assets.json'), 'utf8'))
    assert.equal(assets.dependencies.mermaid.version, '12.3.0')
    assert.deepEqual(assets.dependencies['pi-esp'], { version: '0.1.0', license: 'MIT' })
    const visualizer = path.join(destination, 'src', 'visualizer')
    assert.match(await readFile(path.join(visualizer, 'plugin.html'), 'utf8'), /href="\.\/pi-esp-view\.css"/)
    for (const [source, packaged] of [['view.css', 'pi-esp-view.css'], ['LICENSE', 'licenses/pi-esp@0.1.0/LICENSE'], ['SOURCE.md', 'licenses/pi-esp@0.1.0/SOURCE.md']]) {
      assert.deepEqual(await readFile(path.join(visualizer, packaged)), await readFile(new URL(`../vendor/pi-esp/${source}`, import.meta.url)))
    }
    const orcaNotice = 'licenses/orca-native-chat@1.4.263'
    for (const file of ['LICENSE', 'SOURCE.md']) {
      assert.deepEqual(await readFile(path.join(visualizer, orcaNotice, file)), await readFile(new URL(`../vendor/orca-native-chat/${file}`, import.meta.url)))
    }
    assert.match(await readFile(path.join(visualizer, orcaNotice, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 Lovecast Inc\./)
    assert.match(await readFile(path.join(destination, 'src', 'pi-live.css'), 'utf8'), /Prompt layout adapted from Orca v1\.4\.263/)
    const thirdParty = JSON.parse(await readFile(path.join(visualizer, 'licenses', 'packages.json'), 'utf8'))
    assert.ok(thirdParty.some(p => p.name === 'orca-native-chat' && p.version === '1.4.263' && p.license === 'MIT'))
    const fullRegenerator = await readFile(new URL('../vendor/babel-helpers/LICENSE', import.meta.url), 'utf8')
    let regeneratorNotices = 0
    for (const { path: file } of assets.files.filter(file => file.path.endsWith('.LEGAL.txt'))) {
      const notice = await readFile(path.join(visualizer, file), 'utf8')
      if (notice.includes('/*! regenerator-runtime --')) { assert.ok(notice.endsWith(fullRegenerator)); regeneratorNotices++ }
    }
    assert.ok(regeneratorNotices > 0)
    const stagedPaths = await readdir(destination, { recursive: true })
    assert.ok(stagedPaths.every(file => !/\b(?:bin|server|tail|wire)\.js$/.test(file)))
    assert.ok(stagedPaths.every(file => !file.endsWith('.map') && !file.split(path.sep).includes('node_modules')))
  } finally { await rm(destination, { recursive: true, force: true }) }
})

test('plugin preparation rejects stale viewer sources and unexpected source paths', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openrig-viewer-source-test-'))
  try {
    const inputs = {}
    for (const file of visualizerInputs) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
      await writeFile(path.join(directory, file), 'fixture')
      inputs[file] = createHash('sha256').update('fixture').digest('hex')
    }
    await verifyVisualizerSources({ inputs }, directory)
    await writeFile(path.join(directory, 'vendor', 'pi-esp', 'view.js'), 'changed')
    await assert.rejects(verifyVisualizerSources({ inputs }, directory), /source changed: vendor\/pi-esp\/view\.js/)
    await writeFile(path.join(directory, 'vendor', 'pi-esp', 'view.js'), 'fixture')
    await writeFile(path.join(directory, 'src', 'topology-client.mjs'), 'changed')
    await assert.rejects(verifyVisualizerSources({ inputs }, directory), /source changed/)
    await assert.rejects(verifyVisualizerSources({ inputs: { ...inputs, '../private.yaml': 'not-read' } }, directory), /Unrecognized/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('staging never overwrites an existing destination', async () => {
  const destination = await mkdtemp(path.join(tmpdir(), 'openrig-package-existing-'))
  try {
    await writeFile(path.join(destination, 'keep.txt'), 'preserve')
    await assert.rejects(stagePlugin(destination), /must be empty/)
    assert.equal(await readFile(path.join(destination, 'keep.txt'), 'utf8'), 'preserve')
  } finally { await rm(destination, { recursive: true, force: true }) }
})
