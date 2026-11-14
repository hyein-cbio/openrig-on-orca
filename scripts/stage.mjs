#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { visualizerInputs } from './visualizer-inputs.mjs'

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const runtimeFiles = ['action-files.mjs', 'seat-instructions.mjs', 'seat-tasks.mjs', 'task-files.mjs', 'runtime.mjs', 'pod-inventory.mjs', 'pods.mjs', 'plans.mjs', 'launch-review.mjs', 'examples.mjs', 'example-story.mjs', 'protocol.ts', 'terminal-receipt.mjs', 'workspace-labels.mjs', 'worker.ts']

export async function verifyVisualizerSources(assets, directory) {
  if (!assets.inputs || JSON.stringify(Object.keys(assets.inputs).sort()) !== JSON.stringify(visualizerInputs)) throw new Error('Unrecognized visualizer source inventory; rebuild it first')
  for (const file of visualizerInputs) {
    const hash = createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex')
    if (hash !== assets.inputs[file]) throw new Error(`Visualizer source changed: ${file}; run node scripts/build-visualizer.mjs before packaging`)
  }
}

/** Allowlist shipping files: never package node_modules, indexes, sockets or local state. */
export async function stagePlugin(destination) {
  await mkdir(destination, { recursive: true })
  if ((await readdir(destination)).length) throw new Error('Staging destination must be empty; existing files were not overwritten')
  await mkdir(path.join(destination, 'src'))
  for (const file of ['orca-plugin.json', 'README.md', 'SPEC.md']) await cp(path.join(source, file), path.join(destination, file))
  for (const file of runtimeFiles) await cp(path.join(source, 'src', file), path.join(destination, 'src', file))
  for (const file of ['topology.html', 'topology.css', 'plugin.css']) await cp(path.join(source, 'src', file), path.join(destination, 'src', file))
  const assetsRoot = await realpath(path.join(source, 'src', 'visualizer'))
  const assetsFile = path.join(assetsRoot, 'assets.json')
  const assets = JSON.parse(await readFile(assetsFile, 'utf8'))
  if (assets.producer !== 'openrig-topology-assets-v1' || !Array.isArray(assets.files) || assets.files.length > 1000) throw new Error('Unrecognized visualizer asset inventory; rebuild it first')
  await verifyVisualizerSources(assets, source)
  let bytes = 0
  for (const file of assets.files) {
    if (typeof file.path !== 'string' || !file.path || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(file.path)) throw new Error('Unsafe visualizer asset path')
    const input = await realpath(path.join(assetsRoot, file.path))
    if (!input.startsWith(assetsRoot + path.sep)) throw new Error('Visualizer asset escaped its build directory')
    const data = await readFile(input)
    bytes += data.length
    if (data.length !== file.bytes || bytes > 10 * 1024 * 1024 || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error('Visualizer asset integrity failed; rebuild it first')
    const output = path.join(destination, 'src', 'visualizer', file.path)
    await mkdir(path.dirname(output), { recursive: true })
    await writeFile(output, data, { flag: 'wx' })
  }
  // Copy only inventoried artifacts: a stray local YAML or dependency file never enters the package.
  await cp(assetsFile, path.join(destination, 'src', 'visualizer', 'assets.json'))
  await cp(path.join(source, 'docs'), path.join(destination, 'docs'), { recursive: true })
  return destination
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2] ? path.resolve(process.argv[2]) : await mkdtemp(path.join(tmpdir(), 'openrig-for-orca-plugin-'))
  await stagePlugin(destination)
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  console.log(JSON.stringify({ path: destination, inspect: `orca plugin inspect ${quote(destination)} --json`, install: `orca plugin install ${quote(destination)} --json` }, null, 2))
}
