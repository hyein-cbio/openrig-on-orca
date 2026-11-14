#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const runtimeFiles = ['action-files.mjs', 'seat-instructions.mjs', 'seat-tasks.mjs', 'task-files.mjs', 'runtime.mjs', 'plans.mjs', 'launch-review.mjs', 'examples.mjs', 'example-story.mjs', 'protocol.ts', 'terminal-receipt.mjs', 'terminal-status.tsx', 'workspace-labels.mjs', 'worker.ts', 'panel.tsx', 'examples-panel.tsx']

/** Allowlist shipping files: never package node_modules, indexes, sockets or local state. */
export async function stagePlugin(destination) {
  await mkdir(destination, { recursive: true })
  if ((await readdir(destination)).length) throw new Error('Staging destination must be empty; existing files were not overwritten')
  await mkdir(path.join(destination, 'src'))
  for (const file of ['orca-plugin.json', 'README.md', 'SPEC.md']) await cp(path.join(source, file), path.join(destination, file))
  for (const file of runtimeFiles) await cp(path.join(source, 'src', file), path.join(destination, 'src', file))
  await cp(path.join(source, 'docs'), path.join(destination, 'docs'), { recursive: true })
  return destination
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2] ? path.resolve(process.argv[2]) : await mkdtemp(path.join(tmpdir(), 'openrig-for-orca-plugin-'))
  await stagePlugin(destination)
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  console.log(JSON.stringify({ path: destination, inspect: `orca plugin inspect ${quote(destination)} --json`, install: `orca plugin install ${quote(destination)} --json` }, null, 2))
}
