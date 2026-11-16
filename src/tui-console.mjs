import { realpath } from 'node:fs/promises'
import { configFrom, fail, listSeats } from './runtime.mjs'
import { podConnection } from './pod-inventory.mjs'

// Resolve the native home independently of a pod: an empty no-kernel instance can still show its TUI.
export async function resolveTuiConsole(config, snapshot, source = 'configured', expectedKey, options = {}) {
  if (!['configured', 'tui'].includes(source)) throw fail('invalid_console_source', 'Choose the configured or observed default local TUI instance.')
  let connection
  try { connection = await podConnection(config, source, options.base) }
  catch { throw fail('console_unavailable', 'Start its daemon first, then recheck the selected instance. No alternate instance or daemon was started.') }
  if (expectedKey !== undefined && (typeof expectedKey !== 'string' || expectedKey !== connection.key)) throw fail('console_changed', 'The reviewed TUI instance changed. Refresh and prepare a new review; no terminal was created.')
  const effective = configFrom({ ...config, instanceHome: connection.home, daemonPort: connection.port })
  await listSeats(effective, snapshot, options.execute, options.base)
  const scope = { source, key: connection.key, home: connection.home, port: connection.port, endpoint: connection.endpoint,
    cli: await realpath(snapshot.tools.rig), node: await realpath(snapshot.tools.node), version: snapshot.rigVersion }
  return { config: effective, scope }
}

export async function recheckTuiConsole(config, snapshot, reviewed, options = {}) {
  const resolved = await resolveTuiConsole(config, snapshot, reviewed.source, reviewed.key, options)
  if (JSON.stringify(resolved.scope) !== JSON.stringify(reviewed)) throw fail('console_changed', 'The TUI CLI, version or native connection changed. Prepare a new review; nothing was opened.')
  return resolved
}
