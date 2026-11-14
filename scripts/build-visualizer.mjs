#!/usr/bin/env node
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { visualizerInputs } from './visualizer-inputs.mjs'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const output = path.join(root, 'src', 'visualizer')
const producer = 'openrig-topology-assets-v1'

export async function buildVisualizer() {
  try {
    await readdir(output)
    const existing = JSON.parse(await readFile(path.join(output, 'assets.json'), 'utf8'))
    if (existing.producer !== producer) throw new Error('Refusing to replace unrecognized visualizer output')
  } catch (error) { if (error.code !== 'ENOENT' || error.path !== output) throw error }
  const temporary = await mkdtemp(path.join(root, 'src', '.visualizer-build-'))
  try {
    await build({ absWorkingDir: root, entryPoints: { app: 'src/topology-client.mjs', topology: 'src/topology.mjs', workspace: 'src/plugin-client.mjs' }, bundle: true, splitting: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true, charset: 'ascii', legalComments: 'linked', outdir: temporary, outExtension: { '.js': '.mjs' }, external: ['./mermaid/mermaid.esm.min.mjs', './topology.mjs'] })
    const shell = await readFile(path.join(root, 'src', 'plugin.html'), 'utf8')
    const topology = await readFile(path.join(root, 'src', 'topology.html'), 'utf8')
    const body = /<body>([\s\S]*?)<\/body>/.exec(topology)?.[1]?.replace('<main class="studio">', '<section class="studio">').replace('</main>', '</section>')
    if (!body || shell.split('<!-- TOPOLOGY_CONTENT -->').length !== 2) throw new Error('Invalid unified panel template')
    await writeFile(path.join(temporary, 'plugin.html'), shell.replace('<!-- TOPOLOGY_CONTENT -->', body))
    const mermaid = path.join(root, 'node_modules', 'mermaid')
    const chunks = path.join(mermaid, 'dist', 'chunks', 'mermaid.esm.min')
    const target = path.join(temporary, 'mermaid', 'chunks', 'mermaid.esm.min')
    await mkdir(target, { recursive: true })
    await cp(path.join(mermaid, 'dist', 'mermaid.esm.min.mjs'), path.join(temporary, 'mermaid', 'mermaid.esm.min.mjs'))
    for (const file of (await readdir(chunks)).sort()) if (file.endsWith('.mjs')) await cp(path.join(chunks, file), path.join(target, file))
    const versions = {}, packages = [], visited = new Set()
    await mkdir(path.join(temporary, 'licenses'))
    async function packageAt(name, from) {
      for (let directory = from; ; directory = path.dirname(directory)) {
        const candidate = path.join(directory, 'node_modules', name)
        try { return { directory: candidate, pkg: JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8')) } }
        catch (error) { if (error.code !== 'ENOENT') throw error }
        if (path.dirname(directory) === directory) throw new Error(`Missing dependency: ${name}`)
      }
    }
    async function notices(name, from) {
      const { directory, pkg } = await packageAt(name, from)
      const identity = `${pkg.name}@${pkg.version}`
      if (visited.has(identity)) return
      visited.add(identity)
      const destination = path.join(temporary, 'licenses', `${pkg.name.replace(/^@/, '').replaceAll('/', '__')}@${pkg.version}`)
      await mkdir(destination)
      const licenses = []
      for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isFile() && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(entry.name) && !/\.(?:[cm]?js|ts|sh|py|bat|ps1|exe|map)$/i.test(entry.name)) {
        await cp(path.join(directory, entry.name), path.join(destination, entry.name)); licenses.push(entry.name)
      }
      packages.push({ name: pkg.name, version: pkg.version, license: pkg.license || 'See upstream package', repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '', distribution: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`, licenses })
      for (const dependency of Object.keys(pkg.dependencies || {}).sort()) await notices(dependency, directory)
    }
    for (const name of ['mermaid', 'yaml', 'dompurify']) {
      const { pkg } = await packageAt(name, root)
      versions[name] = { version: pkg.version, license: pkg.license }
      await notices(name, root)
    }
    packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'))
    await writeFile(path.join(temporary, 'licenses', 'packages.json'), JSON.stringify(packages, null, 2) + '\n')
    await writeFile(path.join(temporary, 'licenses', 'README.md'), '# Third-party notices\n\nThese unmodified Mermaid browser modules and the bundled YAML/DOMPurify code are redistributed under their upstream licenses. License and notice files for their production dependency closure are included here (some packages are metadata/type-only and not executed). See packages.json for exact versions, license declarations, distribution links and source repositories, including the EPL-2.0 ELK source repository. Source maps, fonts and native build tools are not shipped.\n')
    const files = []
    async function inventory(directory) {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) await inventory(file)
        else { const bytes = await readFile(file); files.push({ path: path.relative(temporary, file).split(path.sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) }
      }
    }
    await inventory(temporary)
    const inputs = {}
    for (const file of visualizerInputs) inputs[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')
    await writeFile(path.join(temporary, 'assets.json'), JSON.stringify({ producer, dependencies: versions, inputs, files }, null, 2) + '\n')
    await rm(output, { recursive: true, force: true })
    await rename(temporary, output)
    return { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), dependencies: versions, noticePackages: packages.length }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildVisualizer(), null, 2))
