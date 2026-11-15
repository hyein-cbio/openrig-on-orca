#!/usr/bin/env node
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stagePlugin } from './stage.mjs'
import { quote } from '../src/runtime.mjs'
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export async function stageIntelPlugin(destination) {
  await stagePlugin(destination)
  await mkdir(path.join(destination, 'src', 'intel'))
  for (const file of ['runtime.mjs', 'worker.ts']) {
    await copyFile(path.join(source, 'src', 'intel', file), path.join(destination, 'src', 'intel', file))
  }
  const manifestPath = path.join(destination, 'orca-plugin.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.main !== 'src/worker.ts') throw new Error('Original worker entry changed; review Intel staging before proceeding')
  manifest.main = 'src/intel/worker.ts'
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return destination
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2] ? path.resolve(process.argv[2]) : await mkdtemp(path.join(tmpdir(), 'openrig-intel-plugin-'))
  await stageIntelPlugin(destination)
  console.log(JSON.stringify({ path: destination, target: 'darwin-x64', inspect: `orca plugin inspect ${quote(destination)} --json`, install: `orca plugin install ${quote(destination)} --json` }, null, 2))
}
