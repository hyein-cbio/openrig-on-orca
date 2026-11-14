import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { configFrom, fail, instanceDirectory, listInstructionSeats } from './runtime.mjs'
import { podsFromSeats } from './pods.mjs'

/** @returns {Promise<import('./protocol').PodInventory['connection']>} */
export async function podConnection(config, source = 'tui', base = process.env) {
  if (!['tui', 'configured'].includes(source)) throw fail('invalid_instance_source', 'Choose the default local TUI instance or this plugin configuration')
  const home = source === 'tui' ? path.join(config.homePath || base.HOME || homedir(), '.openrig') : instanceDirectory(config)
  let record, canonical
  try {
    canonical = await realpath(home)
    const file = await open(path.join(canonical, 'daemon.json'), 'r')
    try { const bytes = Buffer.alloc(16385), result = await file.read(bytes, 0, bytes.length, 0); if (result.bytesRead > 16384) throw new Error('Daemon record too large'); record = JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8')) }
    finally { await file.close() }
  }
  catch { throw fail('daemon_unavailable', 'No readable daemon record exists for this instance. Nothing was started; choose another source or configure its existing OpenRig home.') }
  if (!Number.isInteger(record.port) || record.port < 1024 || record.port > 65534 || !['127.0.0.1', 'localhost', undefined].includes(record.host)) throw fail('invalid_instance', 'The daemon record does not describe a supported local loopback instance')
  if (source === 'configured' && record.port !== Number(config.daemonPort)) throw fail('instance_port_changed', 'The configured port differs from its daemon record. Recheck the explicit connection; no alternate endpoint was queried.')
  const port = source === 'tui' ? String(record.port) : config.daemonPort
  let configuredHome
  try { configuredHome = await realpath(instanceDirectory(config)) } catch { configuredHome = instanceDirectory(config) }
  const key = createHash('sha256').update(JSON.stringify([canonical, port])).digest('hex')
  return { source, key, home: canonical, port, endpoint: `http://127.0.0.1:${port}`, matchesConfigured: configuredHome === canonical && config.daemonPort === port }
}
/** @returns {Promise<import('./protocol').PodInventory>} */
export async function readPodInventory(config, snapshot, source = 'tui', execute, base = process.env) {
  const connection = await podConnection(config, source, base)
  const effective = configFrom({ ...config, instanceHome: connection.home, daemonPort: connection.port })
  const seats = await listInstructionSeats(effective, snapshot, execute, base, true)
  const pods = podsFromSeats(seats)
  return { connection, observedAt: Date.now(), pods, seats }
}
export async function assertPodInstance(config, expectedKey) {
  if (typeof expectedKey !== 'string' || !/^[a-f0-9]{64}$/.test(expectedKey) || (await podConnection(config, 'configured')).key !== expectedKey) throw fail('instance_changed', 'The selected pod belongs to a different or changed instance. Refresh and explicitly connect it before another review.')
}
export async function connectedPodConfig(config, source, expectedKey, base = process.env) {
  const connection = await podConnection(config, source, base)
  if (connection.key !== expectedKey) throw fail('instance_changed', 'The observed instance changed. Refresh pods and review the connection again.')
  return configFrom({ ...config, instanceHome: source === 'tui' ? connection.home : config.instanceHome, daemonPort: connection.port })
}
