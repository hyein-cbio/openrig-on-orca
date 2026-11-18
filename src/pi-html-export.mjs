import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile, realpath, stat, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { environment, fail, findExecutable, rigInvocation, run, shellCommand } from './runtime.mjs'
import { orcaCommand } from './terminal-receipt.mjs'
import { canExportPiSeat } from './seat-tasks.mjs'

export const PI_SESSION_LIMIT = 32 * 1024 * 1024
export const PI_HTML_LIMIT = 64 * 1024 * 1024
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
export const samePiIdentity = (a, b) => ['nodeId', 'occupantId', 'rigId', 'logicalId', 'podId', 'session', 'file', 'sessionsDir', 'sidecar', 'sessionId', 'launchId', 'dev', 'ino', 'databaseDev', 'databaseIno'].every(key => a[key] === b[key])

async function rigPackage(rig) {
  for (let dir = path.dirname(await realpath(rig)); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    try { const file = path.join(dir, 'package.json'); if (JSON.parse(await readFile(file, 'utf8')).name === '@openrig/cli') return file }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  throw fail('pi_metadata_unavailable', 'Select the npm-installed OpenRig CLI to read exact Native Pi metadata.')
}
export async function readNativePiIdentity(plan, options={}) {
  if (options.identity) return options.identity(plan)
  const execute = options.execute || run
  const selectedEnv = environment(plan.config, options.base), env = { PATH: selectedEnv.PATH, HOME: selectedEnv.HOME, LANG: selectedEnv.LANG || 'en_US.UTF-8' }
  const result = await execute(plan.node, [fileURLToPath(new URL('./pi-session-native.mjs', import.meta.url)), plan.packageFile, plan.home, JSON.stringify(plan.target), String(plan.config.daemonPort)], { env, timeout: 12000, maxBuffer: 65536, signal: options.signal })
  if (!result.ok) {
    let detail = 'Exact Native Pi history is unavailable. No other conversation was selected.'
    try { const parsed = JSON.parse(result.stdout); if (typeof parsed.error === 'string' && parsed.error.length < 400) detail = parsed.error } catch { /* No raw process output crosses the panel bridge. */ }
    throw fail('pi_session_unavailable', detail)
  }
  try { return JSON.parse(result.stdout) } catch { throw fail('pi_session_unavailable', 'Native Pi metadata was unreadable. No session fallback was used.') }
}
async function exporter(config, node, base) {
  const env = environment(config, base), selected = await findExecutable('pi', env)
  if (!selected) throw fail('pi_exporter_missing', 'Pi CLI is unavailable. Add its executable directory to the plugin executable search path; no Pi was installed.')
  const file = await realpath(selected), info = await stat(file), invocation = await rigInvocation(file, node)
  return { ...invocation, path: file, dev: String(info.dev), ino: String(info.ino), size: info.size, mtime: info.mtimeMs }
}

export async function preparePiSource(config, snapshot, connection, seat) {
  if (!canExportPiSeat(seat) || !snapshot.tools.node || !snapshot.tools.rig) throw fail('pi_seat_required', 'Choose one canonical Pi seat from Native topology; personal Pi sessions and other runtimes are not searched.')
  const node = await realpath(snapshot.tools.node)
  const effective = { ...config, instanceHome: connection.home, daemonPort: connection.port, nodePath: node }
  return { node, packageFile: await rigPackage(snapshot.tools.rig), home: connection.home, config: effective,
    source: connection.source, instanceKey: connection.key, target: { rigId: seat.rigId, logicalId: seat.logicalId, podId: seat.podId ?? null, session: seat.session }, seatKey: seat.key }
}

export async function preparePiExport(config, snapshot, connection, seat, options={}) {
  const source = await preparePiSource(config, snapshot, connection, seat)
  const root = await realpath(config.root), id = randomUUID().replaceAll('-', '')
  const plan = { ...source, id, root, directory: path.join(root, 'pi-html', id), exporter: await exporter(source.config, source.node, options.base) }
  const native = await readNativePiIdentity(plan, options)
  if (native.bytes > PI_SESSION_LIMIT) throw fail('pi_session_too_large', 'Pi history exceeds the 32 MiB snapshot limit; no truncated export was produced.')
  return { ...plan, native }
}
export function piExportCommand(plan) {
  return shellCommand(plan.exporter.file, [...plan.exporter.args, '--export', path.join(plan.directory, 'work', 'snapshot.jsonl'), path.join(plan.directory, 'work', 'raw.html')])
}

// Freeze a complete-record prefix, not a moving JSONL tail. Reading the same
// prefix twice detects append-in-progress truncation/rewrite without locking Pi.
export async function copyPiSnapshot(native, destination, options={}) {
  const handle = await open(native.file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || String(before.dev) !== native.dev || String(before.ino) !== native.ino || before.size > PI_SESSION_LIMIT || !before.size) throw fail('pi_session_changed', 'The reviewed Pi file changed or exceeds the snapshot limit.')
    async function prefix() {
      const buffer = Buffer.alloc(before.size); let offset = 0
      while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) throw fail('pi_session_changed', 'Pi history was truncated while copying.'); offset += bytesRead }
      return buffer
    }
    const bytes = await prefix()
    if (options.betweenReads) await options.betweenReads()
    const again = await prefix(), after = await stat(native.file)
    if (!bytes.equals(again) || String(after.dev) !== native.dev || String(after.ino) !== native.ino || after.size < before.size) throw fail('pi_session_changed', 'Pi history was rewritten during the snapshot; retry explicitly after it settles.')
    const end = bytes.lastIndexOf(10)
    if (end < 0) throw fail('pi_session_incomplete', 'Pi history has no complete JSONL header.')
    const complete = bytes.subarray(0, end + 1), lines = new TextDecoder('utf-8', { fatal: true }).decode(complete).split('\n').filter(Boolean)
    for (let i = 0; i < lines.length; i++) {
      let entry; try { entry = JSON.parse(lines[i]) } catch { throw fail('pi_session_incomplete', 'Pi history contains a malformed complete record; no partial conversation was exported.') }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.type !== 'string') throw fail('pi_session_incomplete', 'Pi history contains an invalid complete record.')
      if (i === 0 && (entry.type !== 'session' || entry.id !== native.sessionId)) throw fail('pi_session_changed', 'Pi history no longer matches the reviewed Native session.')
    }
    await writeFile(destination, complete, { flag: 'wx', mode: 0o600 })
    return { bytes: complete.length, omittedTailBytes: bytes.length - complete.length, sha256: hash(complete), snapshotAt: Date.now() }
  } finally { await handle.close() }
}

export function securePiHtml(html, guard, label) {
  html = html.replace(/\r\n?/g, '\n'); guard = guard.replace(/\r\n?/g, '\n')
  if (Buffer.byteLength(html) > PI_HTML_LIMIT || !/^\s*<!doctype html/i.test(html) || !html.includes('id="session-data"') || !/<head\b[^>]*>/i.test(html)) throw fail('pi_html_invalid', 'Pi did not produce a supported standalone HTML export.')
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  const executable = scripts.filter(match => !/\btype\s*=\s*["'](?:application\/json|text\/plain)["']/i.test(match[1]))
  if (scripts.some(match => /\bsrc\s*=/i.test(match[1])) || !executable.length || !executable.at(-1)[2].includes('marked')) throw fail('pi_html_invalid', 'Unsupported Pi HTML script layout; external resources were not opened.')
  const last = executable.at(-1)
  html = html.slice(0, last.index) + `<script>${guard}</script>` + html.slice(last.index)
  const scriptHashes = [...scripts.filter(match => executable.includes(match)).map(match => match[2]), guard].map(script => `'sha256-${createHash('sha256').update(script).digest('base64')}'`)
  const handlers = ["if(window.getSelection().toString())return;this.classList.toggle('expanded')", "if(window.getSelection().toString())return;this.classList.toggle('params-expanded')"]
  const handlerHashes = handlers.map(code => `'sha256-${createHash('sha256').update(code).digest('base64')}'`)
  const policy = `default-src 'none'; script-src ${scriptHashes.join(' ')} 'unsafe-hashes' ${handlerHashes.join(' ')}; style-src 'unsafe-inline'; img-src data:; frame-src 'self' about:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; font-src 'none'; media-src 'none'; worker-src 'none'`
  html = html.replace(/<head\b[^>]*>/i, match => `${match}<meta http-equiv="Content-Security-Policy" content="${escape(policy)}"><meta name="referrer" content="no-referrer">`)
  const wrapped = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escape(policy)}"><meta name="referrer" content="no-referrer"><title>Pi snapshot · ${escape(label)}</title><style>html,body{margin:0;height:100%;background:#18181e;color:#ddd;font:12px system-ui}header{padding:8px 12px}iframe{border:0;width:100%;height:calc(100% - 34px)}</style></head><body><header>${escape(label)} · read-only snapshot · external content blocked</header><iframe title="Pi session snapshot" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escape(html)}"></iframe></body></html>`
  if (Buffer.byteLength(wrapped) > PI_HTML_LIMIT) throw fail('pi_html_too_large', 'The HTML snapshot exceeds the 64 MiB viewer limit.')
  return wrapped
}

export async function createPiExport(plan, options={}) {
  if (options.signal?.aborted) throw fail('cancelled', 'Pi export was cancelled.')
  const current = await readNativePiIdentity(plan, options)
  if (!samePiIdentity(plan.native, current)) throw fail('pi_session_changed', 'Native occupant, account path or Pi history changed since review. Prepare a new export.')
  const selected = await exporter(plan.config, plan.node, options.base)
  if (JSON.stringify(selected) !== JSON.stringify(plan.exporter)) throw fail('pi_exporter_changed', 'The reviewed Pi exporter changed. Prepare a new review.')
  const exportRoot = path.join(plan.root, 'pi-html')
  await mkdir(exportRoot, { recursive: true, mode: 0o700 })
  if (await realpath(exportRoot) !== exportRoot || path.dirname(plan.directory) !== exportRoot) throw fail('pi_export_path', 'The private export directory changed or escaped its configured root.')
  await mkdir(plan.directory, { mode: 0o700 }) // Exclusive; never overwrite another export.
  const work = path.join(plan.directory, 'work'), file = path.join(plan.directory, 'report.html')
  let success = false
  try {
    await mkdir(work, { mode: 0o700 }); await mkdir(path.join(work, 'home'), { mode: 0o700 })
    const captured = await copyPiSnapshot(current, path.join(work, 'snapshot.jsonl'))
    if (!samePiIdentity(current, await readNativePiIdentity(plan, options))) throw fail('pi_session_changed', 'Native Pi session changed during copying. No HTML was opened.')
    const env = { PATH: environment(plan.config, options.base).PATH, HOME: path.join(work, 'home'), PI_CODING_AGENT_DIR: path.join(work, 'home', 'pi'), LANG: 'en_US.UTF-8', TERM: 'dumb' }
    const result = await (options.execute || run)(plan.exporter.file, [...plan.exporter.args, '--export', path.join(work, 'snapshot.jsonl'), path.join(work, 'raw.html')], { cwd: work, env, timeout: 45000, maxBuffer: 65536, signal: options.signal })
    if (!result.ok) throw fail('pi_export_failed', 'Pi HTML export failed. The source session and running agent were not changed; inspect the selected Pi CLI.')
    const rawPath = path.join(work, 'raw.html'), info = await stat(rawPath)
    if (!info.isFile() || info.size > PI_HTML_LIMIT) throw fail('pi_html_too_large', 'Pi output is missing or exceeds the HTML size limit.')
    if (!samePiIdentity(current, await readNativePiIdentity(plan, options))) throw fail('pi_session_changed', 'Native Pi occupant changed before publication. No HTML was opened.')
    const notice = await readFile(new URL('./visualizer/pi-export-guard.js.LEGAL.txt', import.meta.url), 'utf8')
    const guard = `/* Bundled third-party notice: ${notice.replaceAll('*/', '* /')} */\n${await readFile(new URL('./visualizer/pi-export-guard.js', import.meta.url), 'utf8')}`
    const html = securePiHtml(await readFile(rawPath, 'utf8'), guard, `${plan.target.session} · ${new Date(captured.snapshotAt).toISOString()}`)
    await writeFile(file, html, { flag: 'wx', mode: 0o600 }); success = true
    return { kind: 'pi-html', id: plan.id, root: plan.root, workspaceId: '', file, url: pathToFileURL(file).href, session: plan.target.session, sessionId: current.sessionId, seatKey: plan.seatKey, ...captured, htmlHash: hash(html), browser: 'unverified', detail: 'HTML exported. Orca browser opening has not been confirmed.' }
  } finally {
    await rm(work, { recursive: true, force: true })
    if (!success) await rm(plan.directory, { recursive: true, force: true })
  }
}

export async function openPiExport(receipt, options={}) {
  const pending = { ...receipt, browser: 'unverified' }
  try {
    const info = await stat(receipt.file)
    if (!info.isFile() || info.size > PI_HTML_LIMIT) throw new Error('Export size changed')
    if (!/^[a-f0-9]{32}$/.test(receipt.id) || receipt.file !== path.join(receipt.root, 'pi-html', receipt.id, 'report.html') || receipt.url !== pathToFileURL(receipt.file).href || await realpath(receipt.file) !== receipt.file || hash(await readFile(receipt.file)) !== receipt.htmlHash) throw new Error('Export changed')
    const cli = orcaCommand(options.base), execute = options.execute || run
    const call = async args => { const r = await execute(cli, [...args, '--environment', 'local', '--json'], { env: options.base || process.env, timeout: 10000, maxBuffer: 1048576 }); if (!r.ok) throw new Error('Browser command unavailable'); const d = JSON.parse(r.stdout); if (!d.ok) throw new Error('Browser command refused'); return d.result }
    const listed = await call(['tab', 'list', '--worktree', receipt.workspaceId])
    const tabs = Array.isArray(listed.tabs) ? listed.tabs : null
    if (!tabs || listed.truncated) throw new Error('Browser inventory incomplete')
    const matches = tabs.filter(tab => tab.url === receipt.url)
    if (matches.length > 1) throw new Error('Multiple snapshot tabs')
    let page = matches[0]?.browserPageId
    if (matches.length && (typeof page !== 'string' || !page)) throw new Error('Existing tab identity unavailable')
    if (page) await call(['tab', 'switch', '--page', page])
    else page = (await call(['tab', 'create', '--worktree', receipt.workspaceId, '--profile', 'default', '--url', receipt.url])).browserPageId
    if (typeof page !== 'string' || !page) throw new Error('No browser receipt')
    return { ...pending, browser: 'opened', browserPageId: page, detail: 'Orca accepted the snapshot in its built-in browser. This is a fixed export, not a live session view.' }
  } catch { return { ...pending, detail: 'HTML was exported, but browser opening is unverified. Use Open exported HTML in Orca to inspect/reuse the same file; do not export again to recover its view.' } }
}
