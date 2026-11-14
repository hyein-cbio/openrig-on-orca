import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { stagePlugin, verifyVisualizerSources } from '../scripts/stage.mjs'
import { visualizerInputs } from '../scripts/visualizer-inputs.mjs'

test('shipping stage allowlists runtime files and excludes development/local state', async () => {
  const destination = await mkdtemp(path.join(tmpdir(), 'openrig-package-test-'))
  try {
    await stagePlugin(destination)
    const files = await readdir(destination)
    assert.deepEqual(files.sort(), ['README.md', 'SPEC.md', 'docs', 'orca-plugin.json', 'src'])
    assert.deepEqual((await readdir(path.join(destination, 'src'))).sort(), ['action-files.mjs', 'example-story.mjs', 'examples.mjs', 'launch-review.mjs', 'plans.mjs', 'plugin.css', 'protocol.ts', 'runtime.mjs', 'seat-instructions.mjs', 'seat-tasks.mjs', 'task-files.mjs', 'terminal-receipt.mjs', 'topology.css', 'topology.html', 'visualizer', 'worker.ts', 'workspace-labels.mjs'])
    const manifest = JSON.parse(await readFile(path.join(destination, 'orca-plugin.json'), 'utf8'))
    assert.equal(manifest.main, 'src/worker.ts')
    assert.equal(manifest.contributes.panels.length, 1)
    assert.equal(manifest.contributes.panels[0].id, 'openrig')
    assert.equal(manifest.contributes.panels[0].entry, 'src/visualizer/plugin.html')
    assert.equal(manifest.contributes.panels[0].ui, 'html')
    assert.match(await readFile(path.join(destination, 'src', 'topology.html'), 'utf8'), /visualizer\/app\.mjs/)
    const assets = JSON.parse(await readFile(path.join(destination, 'src', 'visualizer', 'assets.json'), 'utf8'))
    assert.equal(assets.dependencies.mermaid.version, '12.3.0')
    assert.ok(assets.files.every(file => !file.path.endsWith('.map') && !file.path.includes('node_modules')))
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
