import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stagePlugin } from '../scripts/stage.mjs'

test('shipping stage allowlists runtime files and excludes development/local state', async () => {
  const destination = await mkdtemp(path.join(tmpdir(), 'openrig-package-test-'))
  try {
    await stagePlugin(destination)
    const files = await readdir(destination)
    assert.deepEqual(files.sort(), ['README.md', 'SPEC.md', 'docs', 'orca-plugin.json', 'src'])
    assert.deepEqual((await readdir(path.join(destination, 'src'))).sort(), ['action-files.mjs', 'example-story.mjs', 'examples-panel.tsx', 'examples.mjs', 'launch-review.mjs', 'panel.tsx', 'plans.mjs', 'protocol.ts', 'runtime.mjs', 'terminal-receipt.mjs', 'terminal-status.tsx', 'worker.ts', 'workspace-labels.mjs'])
    const manifest = JSON.parse(await readFile(path.join(destination, 'orca-plugin.json'), 'utf8'))
    assert.equal(manifest.main, 'src/worker.ts')
  } finally { await rm(destination, { recursive: true, force: true }) }
})

test('staging never overwrites an existing destination', async () => {
  const destination = await mkdtemp(path.join(tmpdir(), 'openrig-package-existing-'))
  try {
    await writeFile(path.join(destination, 'keep.txt'), 'preserve')
    await assert.rejects(stagePlugin(destination), /must be empty/)
    assert.equal(await readFile(path.join(destination, 'keep.txt'), 'utf8'), 'preserve')
  } finally { await rm(destination, { recursive: true, force: true }) }
})
