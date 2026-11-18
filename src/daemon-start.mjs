import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, uptime } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { absolute, configFrom, discover, environment, fail, findExecutable, instanceDirectory, rigInvocation, run } from './runtime.mjs'

const validPort = value => /^\d{4,5}$/.test(value) && Number(value) >= 1024 && Number(value) <= 65534
const absent = error => error?.code === 'ENOENT'
const digest = value => createHash('sha256').update(value).digest('hex')
async function canonicalHome(file, allowMissing) {
  try { return await realpath(file) } catch (error) {
    if (!allowMissing || !absent(error) || path.dirname(file) === file) throw error
    // Missing managed directories are allowed, dangling symlinks are not.
    try { await lstat(file); throw new Error('Unresolved path') } catch (statError) { if (!absent(statError)) throw statError }
    return path.join(await canonicalHome(path.dirname(file), true), path.basename(file))
  }
}
async function boundedNativeFile(file) {
  const info = await lstat(file).catch(error => { if (!absent(error)) throw error })
  if (!info) return null
  if (!info.isFile() || info.size > 16384) throw new Error('Invalid daemon record')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const current = await handle.stat(), buffer = Buffer.alloc(16385)
    if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) throw new Error('Daemon record changed')
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 16384) throw new Error('Invalid daemon record')
    return { bytes: buffer.subarray(0, bytesRead), mtime: current.mtimeMs, ino: current.ino }
  } finally { await handle.close() }
}
const systemLsof = () => findExecutable('lsof', { PATH: '/usr/bin:/usr/sbin:/bin:/sbin' })
const needsLsof = 'Checking an existing database for a start requires the system lsof tool. Use OpenRig directly if unavailable.'
async function requireNoVisibleHolder(file, execute = run) {
  const lsof = await systemLsof()
  if (!lsof) throw fail('daemon_db_busy', needsLsof)
  const holders = await execute(lsof, ['-F', 'p', '--', file], { timeout: 3000, maxBuffer: 64 * 1024 })
  // lsof's clean no-match result rejects visible holders, not all kernel/userspace
  // races. OpenRig must still enforce its own conflict policy and startup locks.
  if (holders.code !== 1 || holders.stdout.trim() || holders.stderr.trim()) throw fail('daemon_db_busy', 'Database ownership is occupied or could not be verified. No start will be attempted.')
}
const fileStamp = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
async function databaseFileStamp(file, primary = false) {
  const info = await lstat(file, { bigint: true }).catch(error => { if (!absent(error)) throw error })
  if (!info) return null
  if (!info.isFile()) throw new Error('Unverified database file')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat({ bigint: true }), head = Buffer.alloc(4096)
    if (!before.isFile() || fileStamp(before) !== fileStamp(info)) throw new Error('Database identity changed')
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    if (primary && (bytesRead < 16 || !head.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')))) throw new Error('Invalid SQLite header')
    if (fileStamp(await lstat(file, { bigint: true })) !== fileStamp(before) || fileStamp(await handle.stat({ bigint: true })) !== fileStamp(before)) throw new Error('Database identity changed')
    return [fileStamp(before), digest(head.subarray(0, bytesRead))]
  } finally { await handle.close() }
}
async function databaseIdentity(file) {
  const home = path.dirname(file)
  if (await canonicalHome(home, true) !== home) throw new Error('Database home changed')
  const [primary, wal, journal] = await Promise.all([databaseFileStamp(file, true), databaseFileStamp(file + '-wal'), databaseFileStamp(file + '-journal')])
  if (!primary) {
    if (wal || journal) throw new Error('Database sidecar exists without its main database')
    return null
  }
  return digest(JSON.stringify([primary, wal, journal]))
}
const bootIdPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
async function readCurrentBootId() {
  if (process.platform === 'darwin') {
    const result = await run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeout: 2000, maxBuffer: 1024 })
    return result.ok ? result.stdout.trim() : ''
  }
  if (process.platform === 'linux') {
    const file = await open('/proc/sys/kernel/random/boot_id', 'r')
    try { const buffer = Buffer.alloc(64), { bytesRead } = await file.read(buffer, 0, buffer.length, 0); return buffer.subarray(0, bytesRead).toString('utf8').trim() }
    finally { await file.close() }
  }
  return ''
}
async function verifiedEarlierBoot(reservation, readBootId, pidExists) {
  try {
    const [record, child, extra] = reservation.bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
    const pid = value => Number.isSafeInteger(value) && value > 1 && value <= 2147483647, started = Date.parse(record?.startedAt)
    if (extra || !pid(record?.launcherPid) || !Number.isFinite(started) || child !== undefined && !pid(child?.childPid)) return false
    let earlier
    if (record.bootId === undefined) {
      const bootAt = Date.now() - uptime() * 1000
      earlier = Math.max(started, reservation.mtime) < bootAt && !pidExists(record.launcherPid) && (!child || !pidExists(child.childPid))
    } else {
      const current = await readBootId()
      earlier = bootIdPattern.test(record.bootId) && bootIdPattern.test(current) && current.toLowerCase() !== record.bootId.toLowerCase()
    }
    return earlier ? new Date(started).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') : false
  } catch { return false }
}
function pidMayExist(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code !== 'ESRCH' }
}
function loopbackPortFree(port) {
  return new Promise(resolve => {
    const probe = createServer(socket => socket.destroy())
    probe.once('error', () => resolve(false))
    probe.listen({ host: '127.0.0.1', port: Number(port), exclusive: true }, () => {
      probe.close(error => resolve(!error))
    })
  })
}

async function verifyNativeDatabase(rig, env, expected, hasDatabase, execute = run) {
  const value = await execute(rig.file, [...rig.args, 'config', 'get', 'db.path', '--json'], { env, timeout: 8000 })
  let database
  try { if (value.ok) database = JSON.parse(value.stdout)?.value } catch { /* Verify before using the native response. */ }
  if (typeof database !== 'string' || !path.isAbsolute(database)) throw fail('daemon_db_unverified', 'Could not verify the selected OpenRig database configuration.')
  const actual = await canonicalHome(database, !hasDatabase).catch(() => null)
  if (actual !== expected) throw fail('daemon_db_changed', 'The selected home configures a different database. Start that instance directly with OpenRig; no default database was chosen.')
}
async function checkConfiguredDatabase(config, snapshot, base, hasDatabase, execute) {
  if (!snapshot.installed || !snapshot.tools.rig || !snapshot.tools.node || !snapshot.rigVersion) throw fail('dependencies_missing', 'Verify Node, OpenRig, tmux and SQLite first.')
  const rig = await rigInvocation(snapshot.tools.rig, snapshot.tools.node)
  const env = environment({ ...config, nodePath: snapshot.tools.node }, base)
  delete env.RIGGED_DB
  await verifyNativeDatabase(rig, env, path.join(instanceDirectory(config), 'openrig.sqlite'), hasDatabase, execute)
}

/** Only the two existing local source choices are accepted; the panel cannot supply a home or database. */
export async function inspectDaemonTarget(config, source, tuiPort, { base = process.env, portFree = loopbackPortFree, pidExists = pidMayExist, readBootId = readCurrentBootId, checkHolders = requireNoVisibleHolder, checkDatabase = async (effective, hasDatabase) => checkConfiguredDatabase(effective, await discover(config, { baseEnv: base, checkProviders: false }), base, hasDatabase) } = {}) {
  if (!['tui', 'configured'].includes(source)) throw fail('invalid_instance_source', 'Choose Default local TUI or Plugin-configured instance.')
  if (tuiPort !== undefined && (typeof tuiPort !== 'string' || tuiPort.length > 5 || source !== 'tui')) throw fail('invalid_daemon_port', 'Enter a local port between 1024 and 65534.')
  const managed = source === 'configured' && !config.instanceHome
  let home = source === 'tui' ? path.join(config.homePath || base.HOME || homedir(), '.openrig') : instanceDirectory(config)
  let port = source === 'configured' ? String(Number(config.daemonPort)) : '', portRequired = false, recordKey = null, dbKey = null, lockKey = null, startPrerequisite = ''
  const result = (status, detail) => ({ source, home, port, portRequired, databaseExists: Boolean(dbKey), databaseKey: dbKey, startPrerequisite, status, detail, key: digest(JSON.stringify([source, home, port, managed, recordKey, dbKey, lockKey])) })
  try {
    if (managed && (await lstat(home).catch(error => { if (!absent(error)) throw error }))?.isSymbolicLink()) return result('blocked', 'The managed instance directory is a symlink. Select its exact existing home instead.')
    home = absolute(await canonicalHome(home, managed), 'OpenRig home')
    const directory = await lstat(home).catch(error => { if (!absent(error)) throw error })
    if ((directory && !directory.isDirectory()) || (!directory && !managed)) return result('blocked', 'This OpenRig home is not an existing directory.')
    const dbPath = path.join(home, 'openrig.sqlite')
    const db = await lstat(dbPath).catch(error => { if (!absent(error)) throw error })
    if ((db && (!db.isFile() || !db.size)) || (!db && !managed)) return result('blocked', 'No regular, nonempty openrig.sqlite was verified for this existing home. No new database will be created here.')
    dbKey = await databaseIdentity(dbPath)
    if (Boolean(db) !== Boolean(dbKey)) return result('blocked', 'The database changed during inspection. Check the selected instance again.')
    if (dbKey && !await systemLsof()) startPrerequisite = needsLsof
    const record = await boundedNativeFile(path.join(home, 'daemon.json'))
    if (record) {
      const entry = JSON.parse(record.bytes.toString('utf8'))
      recordKey = digest(record.bytes)
      if (!Number.isInteger(entry?.port) || !validPort(String(entry.port)) || !['127.0.0.1', 'localhost', undefined].includes(entry.host) || !Number.isSafeInteger(entry.pid) || entry.pid < 2 || entry.pid > 2147483647)
        return result('blocked', 'The native daemon record does not identify a valid local process and port.')
      if (source === 'tui') {
        if (tuiPort !== undefined && (!validPort(tuiPort) || Number(tuiPort) !== entry.port)) {
          portRequired = true
          return result('blocked', `Entered port differs from the native daemon record (${entry.port}). Correct or clear the port and check again.`)
        }
        port = String(entry.port)
      }
      if (port !== String(entry.port)) return result('blocked', `Saved port differs from the native daemon record (${entry.port}). Reconcile them before starting.`)
      if (entry.db !== undefined && (typeof entry.db !== 'string' || !path.isAbsolute(entry.db) || await realpath(entry.db) !== dbPath))
        return result('blocked', 'The native daemon record points to a different database. Use OpenRig directly to inspect it.')
      if (pidExists(entry.pid)) return result('blocked', 'The recorded daemon PID may still be live. No restart or second start is offered.')
    } else if (source === 'tui') {
      portRequired = true
      if (!validPort(tuiPort || '')) return result('port-required', 'No native daemon record. Enter the exact local port to check it before review.')
      port = String(Number(tuiPort))
    }
    if (!validPort(port) || !await portFree(port)) return result('blocked', 'The selected loopback port is occupied or could not be verified free. No alternate port is selected.')
    const effective = configFrom({ ...config, instanceHome: home, daemonPort: port })
    if (effective.instanceHome !== home) return result('blocked', 'The selected home cannot be represented without changing its path. Inspect it directly in OpenRig.')
    await checkDatabase(effective, Boolean(db))
    if (dbKey) await checkHolders(dbPath)
    const lockPath = path.join(home, 'daemon-start.lock'), lock = await boundedNativeFile(lockPath)
    if (lock) {
      const stamp = await verifiedEarlierBoot(lock, readBootId, pidExists)
      if (!stamp) return result('blocked', 'OpenRig has a startup reservation. Use the native CLI to inspect pending startup or recovery; the reservation was not changed.')
      if (await lstat(`${lockPath}.abandoned-${stamp}-${lock.ino}`).catch(error => { if (!absent(error)) throw error })) return result('blocked', 'Native reservation archival has a conflicting file. Inspect the reservation in OpenRig; nothing was removed.')
      lockKey = digest(lock.bytes) // The native CLI, not the inspector, owns archival of an earlier-boot reservation.
    }
    return result('startable', 'The selected loopback port was bindable during this check. OpenRig will bind it again and check its own startup reservation and database conflicts.')
  } catch (error) {
    if (['dependencies_missing', 'daemon_db_unverified', 'daemon_db_changed', 'daemon_db_busy'].includes(error?.code)) return result('blocked', error.message)
    return result('blocked', 'The selected home, database or native daemon record could not be verified. Nothing was started.')
  }
}

async function executableIdentity(pathname) {
  const file = await realpath(pathname), info = await stat(file)
  if (!info.isFile()) throw fail('daemon_target_changed', 'The selected executable is no longer a regular file. Check the instance again.')
  return { file, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
}

export async function resolveDaemonStart(config, snapshot, source, tuiPort, expectedKey, { execute, base = process.env, ...options } = {}) {
  const target = await inspectDaemonTarget(config, source, tuiPort, { ...options, base, checkDatabase: (effective, hasDatabase) => checkConfiguredDatabase(effective, snapshot, base, hasDatabase, execute) })
  if (expectedKey !== undefined && expectedKey !== target.key) throw fail('daemon_target_changed', 'The selected instance changed. Check it again before reviewing a start.')
  if (target.status !== 'startable') throw fail('daemon_start_blocked', target.detail)
  const database = path.join(target.home, 'openrig.sqlite')
  const { key, home, port } = target
  const [cliIdentity, nodeIdentity] = await Promise.all([executableIdentity(snapshot.tools.rig), executableIdentity(snapshot.tools.node)])
  return { config: configFrom({ ...config, instanceHome: home, daemonPort: port }), scope: { source, key, home, port, database, databaseExists: target.databaseExists, databaseKey: target.databaseKey,
    cli: cliIdentity.file, node: nodeIdentity.file, version: snapshot.rigVersion, cliIdentity, nodeIdentity } }
}

export async function recheckDaemonStart(config, snapshot, reviewed, options) {
  const next = await resolveDaemonStart(config, snapshot, reviewed.source, reviewed.source === 'tui' ? reviewed.port : undefined, reviewed.key, options)
  if (JSON.stringify(next.scope) !== JSON.stringify(reviewed)) throw fail('daemon_target_changed', 'The selected home, port or OpenRig executable changed. Prepare a new review.')
}

// Recheck in the result terminal as well as in the worker. Native still owns its
// locks and opens the path itself; the checks do not make that handoff atomic.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, file, expected, encoded] = process.argv.slice(2)
    if (mode !== 'check-reviewed-start' || !path.isAbsolute(file || '') || !/^(?:absent|[a-f0-9]{64})$/.test(expected || '')) throw new Error('Invalid reviewed start guard')
    const { node, cli } = JSON.parse(encoded)
    const recheckExecutables = async () => {
      const current = await Promise.all([executableIdentity(process.execPath), executableIdentity(cli.file)])
      if (JSON.stringify(current) !== JSON.stringify([node, cli])) throw fail('daemon_executable_changed', 'The selected Node or OpenRig executable changed after review. Prepare a new daemon start review.')
    }
    await recheckExecutables()
    const exists = expected !== 'absent', native = await rigInvocation(cli.file, node.file)
    const env = { ...process.env, OPENRIG_HOME: path.dirname(file) }
    // Read the underlying setting before applying the reviewed override.
    delete env.OPENRIG_DB; delete env.RIGGED_DB
    await verifyNativeDatabase(native, env, file, exists)
    if (exists) await requireNoVisibleHolder(file)
    if ((await databaseIdentity(file) ?? 'absent') !== expected) throw new Error('Reviewed database changed')
    await recheckExecutables()
  } catch (error) {
    console.error(['daemon_db_busy', 'daemon_executable_changed', 'daemon_db_unverified', 'daemon_db_changed'].includes(error?.code) ? error.message : 'The database or its files changed after review. Prepare a new daemon start review.')
    process.exitCode = 1
  }
}
