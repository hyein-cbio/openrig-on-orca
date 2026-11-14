import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)

test('byte-preservation attributes apply only to generated output, not authored source', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openrig-attributes-'))
  try {
    await writeFile(path.join(directory, '.gitattributes'), await readFile(new URL('../.gitattributes', import.meta.url)))
    await exec('git', ['init', '-q'], { cwd: directory })
    const files = ['src/visualizer/app.mjs', 'src/visualizer/mermaid/chunks/mermaid.esm.min/vendor.mjs', 'src/visualizer/licenses/upstream/LICENSE', 'src/plugin-client.mjs', 'src/topology.mjs', 'scripts/build-visualizer.mjs']
    const result = await exec('git', ['-c', 'core.attributesFile=/dev/null', 'check-attr', 'whitespace', '--', ...files], { cwd: directory })
    assert.deepEqual(result.stdout.trim().split('\n'), files.map((file, i) => `${file}: whitespace: ${i < 3 ? 'unset' : 'unspecified'}`))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
