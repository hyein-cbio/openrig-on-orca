// Read-only Native Pi metadata. Run with the selected ordinary Node so OpenRig's
// SQLite binding never loads into Orca/Electron's incompatible native ABI.
import { createRequire } from 'node:module'
import { realpath, open, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const invalid = (message, pending = false) => { throw Object.assign(new Error(message), { code: 'pi_session_metadata', pending }) }
export const inside = (root, file) => file.startsWith(root + path.sep)
// The Pi runner stores compaction summaries (including the last requested
// compaction) alongside identity. Keep their budget separate from daemon.json.
const RUNNER_STATE_LIMIT = 1024 * 1024
export async function smallJson(file, limit=16384) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit) invalid('Native metadata is missing or oversized')
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length !== stat.size) invalid('Native metadata changed while reading')
    return JSON.parse(bytes.subarray(0, length).toString('utf8'))
  } finally { await handle.close() }
}

export function queryPiIdentity(db, home, target, live = false) {
  const rows = db.prepare(`SELECT n.id AS nodeId, n.rig_id AS rigId, n.logical_id AS logicalId,
    n.pod_id AS podId, n.runtime, s.id AS occupantId, s.session_name AS session,
    s.resume_type AS resumeType, s.resume_token AS file, b.tmux_session AS binding
    FROM nodes n JOIN rigs r ON r.id=n.rig_id
    LEFT JOIN sessions s ON s.node_id=n.id AND s.id=(SELECT MAX(s2.id) FROM sessions s2 WHERE s2.node_id=n.id)
    LEFT JOIN bindings b ON b.node_id=n.id
    WHERE n.rig_id=? AND n.logical_id=? AND r.archived_at IS NULL`).all(target.rigId, target.logicalId)
  if (rows.length !== 1) invalid('Native seat identity is missing or ambiguous')
  const row = rows[0]
  if (row.runtime !== 'pi' || row.podId !== target.podId || (row.session != null && row.session !== target.session) || (row.binding != null && row.binding !== target.session)) invalid('The selected seat has no matching managed Native Pi occupant')
  const seat = { nodeId: String(row.nodeId), rigId: row.rigId, logicalId: row.logicalId, podId: row.podId, session: target.session }
  // During restore the registered node can outlive its binding and resume token.
  // Pin the node but do not follow any file until both are recorded again.
  if (live && (row.session == null || row.binding == null || row.resumeType == null || (row.resumeType === 'pi_session_file' && row.file == null))) return { ...seat, pending: true }
  if (row.session !== target.session || row.binding !== target.session) invalid('The selected seat has no matching managed Native Pi occupant')
  if (row.resumeType !== 'pi_session_file') invalid('Pi has not recorded a supported Native session file yet')
  if (typeof row.file !== 'string' || !path.isAbsolute(row.file) || !row.file.endsWith('.jsonl') || /[\0\r\n]/.test(row.file)) invalid('Pi has not recorded an exact session file yet')
  let stateRoot = path.join(home, 'state', 'pi')
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='seat_runtime_switches'").get()) {
    const switchRow = db.prepare(`SELECT successor_generation FROM seat_runtime_switches
      WHERE node_id=? AND to_runtime='pi' AND committed_at IS NOT NULL ORDER BY rowid DESC LIMIT 1`).get(row.nodeId)
    if (switchRow) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(switchRow.successor_generation)) invalid('Native Pi account-switch metadata is ambiguous')
      stateRoot = path.join(stateRoot, 'account-switches', switchRow.successor_generation)
    }
  }
  return { ...row, occupantId: String(row.occupantId), sessionsDir: path.join(stateRoot, target.session, 'sessions'), sidecar: path.join(stateRoot, target.session, 'runner-state.json') }
}

export async function validatePiFile(identity, home) {
  const canonicalHome = await realpath(home), managed = await realpath(path.join(canonicalHome, 'state', 'pi'))
  if (!inside(canonicalHome, managed)) invalid('Managed Pi state escaped the Native instance')
  const sessionsDir = await realpath(identity.sessionsDir), file = await realpath(identity.file), sidecar = await realpath(identity.sidecar)
  const relative = path.relative(managed, file).split(path.sep)
  // An account move can retain an explicitly resumed file in the seat's older
  // managed directory. Follow only the Native token + current sidecar, never scan.
  const ownedFile = relative[0] === identity.session && relative[1] === 'sessions' && relative.length >= 3 || relative[0] === 'account-switches' && /^[A-Za-z0-9_-]{1,200}$/.test(relative[1] || '') && relative[2] === identity.session && relative[3] === 'sessions' && relative.length >= 5
  if (!inside(managed, sessionsDir) || !inside(managed, file) || !ownedFile || !inside(managed, sidecar)) invalid('Native Pi file is outside the selected managed seat; no personal session fallback is allowed')
  const state = await smallJson(sidecar, RUNNER_STATE_LIMIT)
  if (typeof state.ready !== 'boolean' || typeof state.launchId !== 'string' || !state.launchId || typeof state.sessionId !== 'string' || !state.sessionId || typeof state.sessionFile !== 'string' || await realpath(state.sessionFile) !== file) invalid('Pi runner and Native session identity disagree or are not initialized', true)
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat(), buffer = Buffer.alloc(16384)
    if (!stat.isFile()) invalid('Pi session history is not a regular file')
    if (!stat.size) invalid('Pi session history has not been created yet', true)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0), end = buffer.subarray(0, bytesRead).indexOf(10)
    if (end < 0) invalid('Pi session header is incomplete or oversized', bytesRead < buffer.length)
    const header = JSON.parse(buffer.subarray(0, end).toString('utf8'))
    if (header.type !== 'session' || header.id !== state.sessionId || !Number.isInteger(header.version) || header.version < 1) invalid('Pi history header does not match its Native runner session')
    return { nodeId: String(identity.nodeId), occupantId: identity.occupantId, rigId: identity.rigId, logicalId: identity.logicalId, podId: identity.podId, session: identity.session,
      file, sessionsDir, sidecar, sessionId: header.id, launchId: state.launchId, dev: String(stat.dev), ino: String(stat.ino), bytes: stat.size }
  } finally { await handle.close() }
}

async function selectedDatabase(home, port) {
  const database = path.join(home, 'openrig.sqlite'), record = await smallJson(path.join(home, 'daemon.json'))
  const info = await lstat(database)
  if (!info.isFile() || record?.port !== Number(port) || typeof record?.db !== 'string' || !path.isAbsolute(record.db) || await realpath(record.db) !== database) invalid('The selected Native daemon database could not be verified as this home’s standard database.')
  return { database, databaseDev: String(info.dev), databaseIno: String(info.ino) }
}

export async function readPiIdentity(packageFile, home, target, port, live = false) {
  const canonicalHome = await realpath(home), bound = await selectedDatabase(canonicalHome, port)
  const require = createRequire(packageFile), Database = require('better-sqlite3')
  const db = new Database(bound.database, { readonly: true, fileMustExist: true })
  try {
    const row = db.transaction(() => queryPiIdentity(db, canonicalHome, target, live))()
    let identity = row
    if (!row.pending) try { identity = await validatePiFile(row, canonicalHome) } catch (error) {
      if (!live || !(error.pending || error.code === 'ENOENT')) throw error
      const { nodeId, rigId, logicalId, podId, session } = row
      identity = { nodeId: String(nodeId), rigId, logicalId, podId, session, pending: true }
    }
    const current = await selectedDatabase(canonicalHome, port)
    if (current.databaseDev !== bound.databaseDev || current.databaseIno !== bound.databaseIno) invalid('The selected Native daemon database changed during verification.')
    return { ...identity, databaseDev: bound.databaseDev, databaseIno: bound.databaseIno }
  } finally { db.close() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [packageFile, home, encoded, port, mode] = process.argv.slice(2)
    console.log(JSON.stringify(await readPiIdentity(packageFile, home, JSON.parse(encoded), port, mode === 'live')))
  } catch (error) { console.log(JSON.stringify({ error: error.code === 'pi_session_metadata' ? error.message : error.code === 'ENOENT' ? 'The exact Native Pi session or runner metadata file is missing or not created yet.' : 'The installed Native Pi metadata schema or file is unavailable. No other session was selected.' })); process.exitCode = 1 }
}
