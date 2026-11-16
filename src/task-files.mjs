import { createHash } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { environment, fail, rigInvocation, run } from './runtime.mjs'
import { instructionEndpoint } from './seat-instructions.mjs'
import { utf8Excerpt } from './report-preview.mjs'
export const taskHash = body => createHash('sha256').update(body).digest('hex')
export const validTaskId = id => typeof id === 'string' && /^qitem-orca-[a-f0-9]{32}$/.test(id)
export const taskBodyPath = (root, id) => path.join(root, 'actions', id, 'body.txt')

export async function stageTaskBody(root, task) {
  if (!validTaskId(task.id) || task.bodyFile !== taskBodyPath(root, task.id)) throw fail('invalid_task', 'Task input was not prepared by this instance')
  await mkdir(path.join(root, 'actions'), { recursive: true, mode: 0o700 })
  await mkdir(path.dirname(task.bodyFile), { mode: 0o700 }) // Exclusive: never replace an earlier request's body.
  await writeFile(task.bodyFile, task.body, { flag: 'wx', mode: 0o600 })
  await chmod(task.bodyFile, 0o400)
}

/** Read back only the reviewed request; never create, wake, retry, or return the private request body.
 * @returns {Promise<import('./protocol').TaskStatus>}
 */
export async function checkTask(config, snapshot, record, execute = run, baseEnv = process.env) {
  const unknown = detail => ({ id: record.id, destination: record.destination, registration: 'unverified', state: 'unknown', detail })
  if (record.config !== JSON.stringify(config)) return unknown('Instance configuration changed. Reconcile at the original endpoint; no other instance was queried.')
  if (!validTaskId(record.id) || !snapshot.tools.rig || !snapshot.tools.node) return unknown('The saved request or CLI is unavailable. No retry was performed.')
  const rig = await rigInvocation(snapshot.tools.rig, snapshot.tools.node)
  const result = await execute(rig.file, [...rig.args, 'queue', 'show', '--full', '--json', '--', record.id], {
    env: { ...environment({ ...config, nodePath: snapshot.tools.node }, baseEnv), OPENRIG_URL: instructionEndpoint(config), OPENRIG_HOST_SELECTED: 'local' }, timeout: 15000
  })
  if (!result.ok) return unknown('Registration is not confirmed. A missing row or timeout does not exclude a pending commit; inspect before retrying.')
  let row
  try { row = JSON.parse(result.stdout) } catch { return unknown('The CLI returned an unreadable result. No retry was performed.') }
  // Native owners may replace summary with a short result; the request body is immutable.
  if (row?.qitemId !== record.id || row.destinationSession !== record.destination || (record.source !== undefined && row.sourceSession !== record.source) || typeof row.body !== 'string' || taskHash(row.body) !== record.bodyHash) return unknown('The returned row does not match the reviewed request. No registration claim or retry was made.')
  const states = ['pending', 'in-progress', 'done', 'blocked', 'failed', 'denied', 'canceled', 'handed-off']
  const excerpt = typeof row.resolution === 'string' && row.resolution.trim() ? utf8Excerpt(row.resolution, 16384) : null
  return { id: record.id, destination: record.destination, registration: 'verified', state: states.includes(row.state) ? row.state : 'unknown',
    ...(excerpt ? { resolution: { body: excerpt.preview, bytes: excerpt.previewBytes, totalBytes: excerpt.totalBytes, truncated: excerpt.truncated } } : {}),
    detail: 'The matching durable row exists. Its state is a recorded workflow status, not proof of delivery, acknowledgment or correct results.' }
}
