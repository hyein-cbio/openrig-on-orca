import { execFile } from 'node:child_process'
import { access, realpath, readFile, stat, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const OPENRIG_VERSION = '0.7.13'
export const DEFAULT_ROOT = path.join(homedir(), '.local', 'share', 'openrig-for-orca')
export const PROVIDERS = ['none', 'claude', 'codex', 'both']
export const DEFAULT_CONFIG = {
  provider: 'none', root: DEFAULT_ROOT, daemonPort: '43811', nodePath: '', npmPath: '', rigPath: '',
  tmuxPath: '', extraPath: '', homePath: '', codexHome: '', claudeConfigDir: '', instanceHome: ''
}

export function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

export function absolute(value, name, home = homedir()) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw fail('invalid_config', `${name}: invalid path`)
  const expanded = value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value
  if (!path.isAbsolute(expanded)) throw fail('invalid_config', `${name}: use an absolute path`)
  return path.normalize(expanded)
}

export function configFrom(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('invalid_config', 'Expected a configuration object')
  const result = { ...DEFAULT_CONFIG }
  for (const [key, value] of Object.entries(input)) {
    if (!(key in DEFAULT_CONFIG) || !Object.hasOwn(DEFAULT_CONFIG, key) || typeof value !== 'string') {
      throw fail('invalid_config', `Unknown or non-string setting: ${key}`)
    }
    result[key] = value.trim()
  }
  if (!/^\d+$/.test(result.daemonPort) || Number(result.daemonPort) < 1024 || Number(result.daemonPort) > 65534) throw fail('invalid_config', 'daemonPort must be between 1024 and 65534')
  if (!PROVIDERS.includes(result.provider)) throw fail('invalid_config', 'Choose none, claude, codex or both')
  for (const key of ['root', 'nodePath', 'npmPath', 'rigPath', 'tmuxPath', 'homePath', 'codexHome', 'claudeConfigDir', 'instanceHome']) {
    if (result[key]) result[key] = absolute(result[key], key)
  }
  if (!result.root || result.root === path.parse(result.root).root) throw fail('invalid_config', 'Choose a private, non-root data directory')
  if (/[\0\r\n]/.test(result.extraPath)) throw fail('invalid_config', 'Invalid executable search path')
  if (result.extraPath) result.extraPath = result.extraPath.split(path.delimiter).map(p => absolute(p, 'extraPath')).join(path.delimiter)
  return result
}

export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
export const shellCommand = (file, args = []) => [file, ...args].map(quote).join(' ')

export const instanceDirectory = config => config.instanceHome || path.join(config.root, 'instance')

export function environment(config, base = process.env) {
  const home = config.homePath || base.HOME || homedir()
  const bins = [config.nodePath && path.dirname(config.nodePath), config.tmuxPath && path.dirname(config.tmuxPath),
    config.npmPath && path.dirname(config.npmPath), path.join(config.root, 'runtime', 'node_modules', '.bin'),
    path.join(config.root, 'providers', 'node_modules', '.bin'), config.extraPath, base.PATH,
    path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  const env = { ...base, HOME: home, OPENRIG_HOME: instanceDirectory(config), PATH: bins.filter(Boolean).join(path.delimiter) }
  // Never inherit another seat's identity, instance endpoint, or tmux client context.
  for (const key of Object.keys(env)) if (key.startsWith('OPENRIG_') && key !== 'OPENRIG_HOME') delete env[key]
  env.OPENRIG_PORT = config.daemonPort
  env.OPENRIG_HOST = '127.0.0.1'
  env.OPENRIG_BIND_HOST = '127.0.0.1'
  env.OPENRIG_URL = `http://127.0.0.1:${config.daemonPort}`
  env.OPENRIG_HOST_SELECTED = 'local'
  delete env.TMUX
  delete env.TMUX_PANE
  delete env.NODE_OPTIONS
  delete env.NODE_REPL_EXTERNAL_MODULE
  if (config.homePath) {
    // Sandbox homes must not accidentally inherit an Orca-managed personal account.
    delete env.CODEX_HOME
    delete env.CLAUDE_CONFIG_DIR
  }
  if (config.codexHome) env.CODEX_HOME = config.codexHome
  if (config.claudeConfigDir) env.CLAUDE_CONFIG_DIR = config.claudeConfigDir
  return env
}

export function run(file, args = [], options = {}) {
  return new Promise(resolve => {
    execFile(file, args, { timeout: 12000, maxBuffer: 2 * 1024 * 1024, ...options }, (error, stdout = '', stderr = '') => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export async function executable(file) {
  try { await access(file, constants.X_OK); return (await stat(file)).isFile() } catch { return false }
}

export async function findExecutable(name, env, override = '') {
  if (override) return await executable(override) ? override : null
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name)
    if (await executable(file)) return file
  }
  return null
}

export function nodeSupported(version, platform = process.platform, arch = process.arch) {
  const major = Number(String(version).replace(/^v/, '').split('.')[0])
  return (major === 22 || major === 24) && !(platform === 'darwin' && arch === 'arm64' && major !== 22)
}

export async function discover(config, { baseEnv = process.env, execute = run, platform = process.platform, arch = process.arch, checkProviders = true } = {}) {
  if (!['darwin', 'linux'].includes(platform)) throw fail('unsupported_platform', 'Use macOS or Linux; native Windows is not supported')
  let env = environment(config, baseEnv)
  const names = ['node', 'npm', 'rig', 'tmux', 'claude', 'codex', 'brew', 'port', 'curl', 'jq', 'git', 'gh', 'docker', 'op', 'sudo', 'apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk']
  const tools = Object.fromEntries(await Promise.all(names.map(async name => [name, await findExecutable(name, env, config[`${name}Path`] || '')])))
  const candidates = config.nodePath ? [tools.node] : [
    ...(config.provider === 'codex' ? [tools.codex, tools.claude] : [tools.claude, tools.codex]).filter(Boolean).map(p => path.join(path.dirname(p), 'node')),
    tools.node, process.execPath
  ]
  const nodes = []
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    if (!await executable(candidate)) continue
    const result = await execute(candidate, ['-p', 'JSON.stringify({version:process.version,electron:!!process.versions.electron})'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } })
    try {
      const info = JSON.parse(result.stdout)
      nodes.push({ path: candidate, version: info.version, compatible: result.ok && !info.electron && nodeSupported(info.version, platform, arch) })
    } catch { nodes.push({ path: candidate, version: 'unavailable', compatible: false }) }
  }
  const selected = nodes.find(n => n.compatible)
  tools.node = selected?.path || null
  if (selected) {
    env = environment({ ...config, nodePath: selected.path }, baseEnv)
    // Re-resolve npm from the selected Node's PATH, rather than mixing nvm installs.
    tools.npm = await findExecutable('npm', env, config.npmPath)
  }
  let tmuxVersion = null
  if (tools.tmux) {
    const result = await execute(tools.tmux, ['-V'], { env })
    if (result.ok) tmuxVersion = result.stdout.trim()
    else tools.tmux = null
  }
  let rigVersion = null
  let sqlite = { status: 'unavailable', detail: 'Install OpenRig with the selected Node first.' }
  if (tools.rig && tools.node) {
    const command = await rigInvocation(tools.rig, tools.node)
    const result = await execute(command.file, [...command.args, '--version'], { env })
    if (result.ok && /^\d+\.\d+\.\d+/.test(result.stdout.trim())) rigVersion = result.stdout.trim()
    sqlite = await verifySqlite(tools.rig, tools.node, env, execute)
  }
  const providers = []
  // Skipping provider auth must not change the preference order of the Node candidates above.
  for (const provider of !checkProviders || config.provider === 'none' ? [] : config.provider === 'both' ? ['claude', 'codex'] : [config.provider]) {
    const file = tools[provider]
    let status = 'missing'
    if (file) {
      const result = await execute(file, provider === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'], { env })
      // Do not return or persist auth command output: it may contain account information.
      status = result.ok ? 'authenticated' : 'sign-in-required'
    }
    providers.push({ provider, path: file, status })
  }
  const installed = Boolean(tools.node && tools.tmux && rigVersion && sqlite.status === 'ready')
  return {
    platform, arch, config, nodes, tools, rigVersion, tmuxVersion, sqlite, providers,
    stage: !installed ? 'dependencies-missing' : !providers.length ? 'installed-agent-deferred' : providers.every(p => p.status === 'authenticated') ? 'ready' : 'agent-setup-required',
    installed, ready: installed && providers.length > 0 && providers.every(p => p.status === 'authenticated')
  }
}

export async function rigInvocation(rig, node) {
  const file = await realpath(rig)
  if (/\.(?:m?js|cjs)$/.test(file)) return { file: node, args: [file] }
  const handle = await open(file, 'r')
  let head
  try {
    const buffer = Buffer.alloc(200)
    const { bytesRead } = await handle.read(buffer, 0, 200, 0)
    head = buffer.subarray(0, bytesRead).toString('utf8')
  } finally { await handle.close() }
  // Explicitly select Node for standard npm-installed rig; don't trust its env shebang.
  return /^#!.*\bnode\b/.test(head) ? { file: node, args: [file] } : { file: rig, args: [] }
}

async function verifySqlite(rig, node, env, execute) {
  try {
    let dir = path.dirname(await realpath(rig))
    while (dir !== path.dirname(dir)) {
      try {
        const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
        if (pkg.name === '@openrig/cli') {
          const script = `const {createRequire}=require('node:module'); const r=createRequire(${JSON.stringify(path.join(dir, 'package.json'))}); const D=r('better-sqlite3'); const db=new D(':memory:'); db.prepare('select 1').get(); db.close()`
          const result = await execute(node, ['-e', script], { env })
          return result.ok ? { status: 'ready', detail: 'SQLite loaded and queried with the selected Node.' }
            : { status: 'failed', detail: 'SQLite binding failed. Reinstall OpenRig with the selected Node (native ABI/build tools may be required).' }
        }
      } catch { /* A parent without this package's metadata is expected. */ }
      dir = path.dirname(dir)
    }
  } catch { /* A wrapper without a resolvable package needs manual selection. */ }
  return { status: 'unverified', detail: 'Select the npm-installed rig entry to verify its SQLite binding.' }
}

export function commandEnvironment(config, snapshot, base = process.env) {
  const env = environment({ ...config, nodePath: snapshot.tools.node || config.nodePath, tmuxPath: snapshot.tools.tmux || config.tmuxPath }, base)
  const assignments = ['HOME', 'OPENRIG_HOME', 'OPENRIG_PORT', 'OPENRIG_HOST', 'OPENRIG_BIND_HOST', 'OPENRIG_URL', 'OPENRIG_HOST_SELECTED', 'PATH', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].filter(k => env[k]).map(k => `${k}=${quote(env[k])}`)
  // Explicitly remove inherited identities/endpoints in the receiving Orca shell, too.
  const cleared = [...new Set(['TMUX', 'TMUX_PANE', 'NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    ...Object.keys(base).filter(k => /^OPENRIG_[A-Z0-9_]+$/.test(k))])]
  return `${cleared.map(k => `unset ${k};`).join(' ')} ${assignments.map(a => `export ${a};`).join(' ')}`
}

export function rowsFrom(payload) {
  if (Array.isArray(payload)) return payload
  if (payload?.truncated) throw fail('seat_list_truncated', 'OpenRig returned an incomplete seat list. Inspect the full team in its dashboard; no attach target was guessed.')
  if (payload && Array.isArray(payload.entries)) return payload.entries
  if (payload && Array.isArray(payload.items)) return payload.items
  if (payload && Array.isArray(payload.nodes)) return payload.nodes
  throw fail('invalid_rig_output', 'OpenRig returned an unknown node-list format')
}

export function seatsFrom(payload) {
  return rowsFrom(payload).filter(row => row && typeof row.rigId === 'string' && typeof row.logicalId === 'string' && (typeof row.canonicalSessionName === 'string' || row.canonicalSessionName === null))
    .map(row => ({
      key: JSON.stringify([row.rigId, row.logicalId]), rigId: row.rigId, rigName: String(row.rigName || row.rigId), rigNameKnown: typeof row.rigName === 'string' && Boolean(row.rigName.trim()),
      podId: typeof row.podId === 'string' || row.podId === null ? row.podId : undefined, podNamespace: typeof row.podNamespace === 'string' ? row.podNamespace : null,
      logicalId: row.logicalId, session: typeof row.canonicalSessionName === 'string' ? row.canonicalSessionName : '', runtime: String(row.runtime || 'unknown'),
      status: row.canonicalSessionName === null && row.sessionStatus === null && row.lifecycleState === 'detached' ? 'not-started' : String(row.sessionStatus || row.lifecycleState || 'unknown'),
      lifecycle: typeof row.lifecycleState === 'string' ? row.lifecycleState : 'unknown',
      model: typeof row.model === 'string' ? row.model : null, cwd: typeof row.cwd === 'string' ? row.cwd : null,
      attention: Boolean(row.needsAttention || row.arbitratedNeedsInput), activity: String(row.agentActivity?.state || 'unknown')
    }))
}

/** @returns {Promise<import('./protocol').State['daemon']>} */
export async function daemonState(config, snapshot) {
  if (!snapshot.installed) return { status: 'not-installed', detail: 'Install and verify OpenRig, tmux and SQLite first.' }
  try {
    await listSeats(config, snapshot)
    return { status: 'reachable', detail: 'This instance responded. No agents were started by this check.' }
  } catch {
    return { status: 'unavailable', detail: 'Cannot reach or verify this instance. Start daemon · no agents, inspect its terminal, then Recheck environment.' }
  }
}

// Messaging must not inherit a persisted remote-host selection or a legacy URL alias.
export async function listInstructionSeats(config, snapshot, execute = run, base = process.env, requirePods = false) {
  return listSeats(config, snapshot, (file, args, options) => execute(file, args, { ...options,
    env: { ...options.env, OPENRIG_URL: `http://127.0.0.1:${config.daemonPort}`, OPENRIG_HOST_SELECTED: 'local' }
  }), base, requirePods)
}

export async function listSeats(config, snapshot, execute = run, base = process.env, requirePods = false) {
  if (!snapshot.tools.rig || !snapshot.tools.node || !snapshot.tools.tmux) throw fail('dependencies_missing', 'Node, OpenRig and tmux are required')
  try { await access(path.join(instanceDirectory(config), 'daemon.json')) } catch {
    throw fail('daemon_unavailable', 'This instance has no daemon state. Start its daemon first; no fallback to another instance was attempted.')
  }
  const command = await rigInvocation(snapshot.tools.rig, snapshot.tools.node)
  // Native 0.7.12/0.7.13 do not project cwd. Keep it unverified instead of making every seat query fail.
  const result = await execute(command.file, [...command.args, 'ps', '--nodes', '-A', '--json', '--no-cleanup', '--fields',
    'rigId,rigName,logicalId,podId,podNamespace,canonicalSessionName,runtime,model,sessionStatus,lifecycleState,needsAttention,arbitratedNeedsInput,agentActivity'], { env: environment({ ...config, nodePath: snapshot.tools.node }, base) })
  if (!result.ok) throw fail('daemon_unavailable', 'Cannot read OpenRig seats. Start this instance’s daemon or check its terminal/logs; it was not started automatically.')
  try {
    const payload = JSON.parse(result.stdout)
    const rows = rowsFrom(payload)
    if (requirePods && rows.some(row => !row || typeof row.rigName !== 'string' || !row.rigName.trim() || !(typeof row.podId === 'string' || row.podId === null) || !(typeof row.podNamespace === 'string' || row.podNamespace === null))) throw fail('invalid_inventory', 'Native pod fields are missing. No incomplete pod list was displayed.')
    const seats = seatsFrom(payload)
    if (requirePods && seats.length !== rows.length) throw fail('invalid_inventory', 'Some native seat identities could not be decoded. No pod list was guessed.')
    return seats
  } catch (error) {
    if (error.code) throw error
    throw fail('invalid_rig_output', 'OpenRig did not return valid seat JSON')
  }
}
