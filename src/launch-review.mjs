import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { absolute, environment, fail, OPENRIG_VERSION, rigInvocation, run } from './runtime.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const parse = result => {
  if (!result.ok) throw fail('launch_review_failed', 'OpenRig could not create or inspect a frozen launch bundle. No team was launched.')
  try { return JSON.parse(result.stdout) } catch { throw fail('launch_review_failed', 'OpenRig returned invalid launch-review data') }
}

export function reviewDisplay(inspection, cwd, archiveHash) {
  const behaviour = inspection.behaviour
  if (inspection.digestValid !== true || inspection.integrityResult?.passed !== true || behaviour?.schema !== 'openrig.bundle-behaviour/v1' || behaviour.state !== 'generated' || !Array.isArray(behaviour.team) || !behaviour.team.length || !Array.isArray(behaviour.posture) || !Array.isArray(behaviour.unknownBeforeLaunch)) {
    throw fail('launch_review_failed', 'Bundle integrity or its behaviour review is incomplete; launch is blocked')
  }
  const seats = behaviour.team.map(seat => {
    const posture = behaviour.posture.find(p => p.seat === seat.seat)
    if (!posture || !['claude-code', 'codex', 'terminal'].includes(seat.runtime)) throw fail('launch_review_failed', 'A seat has an unsupported runtime or no permission review')
    return {
      seat: seat.seat, runtime: seat.runtime, profile: seat.profile || 'unspecified',
      model: seat.runtime === 'terminal' ? 'not applicable (terminal)' : seat.model || 'UNVERIFIED: inspection did not resolve a model; agent/profile or native defaults may apply',
      permissionSelection: posture.selection || 'UNVERIFIED: no declared permission selection',
      permissionBasis: posture.basis || 'unknown', nativePermissionEffect: posture.nativeEffect || 'unknown',
      permissionPrompts: posture.permissionPrompts || 'unknown', shellAccess: posture.shellAccess || 'UNVERIFIED', cwd
    }
  })
  if ((behaviour.toldFiles || []).some(file => file.resolution !== 'archive')) {
    throw fail('launch_review_failed', 'A declared startup resource is not frozen in the archive; launch is blocked')
  }
  const unknown = [...behaviour.unknownBeforeLaunch.map(item => `${item.subject}: ${item.reason}`)]
  if (seats.some(seat => seat.model.startsWith('UNVERIFIED'))) unknown.push('Model: unresolved seats may use agent/profile or native CLI defaults that this plugin cannot verify.')
  if (seats.some(seat => seat.nativePermissionEffect !== 'verified')) unknown.push('Permissions: declared launch posture is not proof of effective native/host enforcement.')
  const display = {
    archiveSha256: archiveHash, seats, startupFiles: behaviour.toldFiles || [],
    alsoRuns: behaviour.alsoRuns || [], writes: behaviour.writes || [],
    outsideAddresses: behaviour.outsideAddresses || [], unverified: unknown
  }
  if (JSON.stringify(display, null, 2).length > 12000) throw fail('launch_review_failed', 'Launch review is too large to display completely; use OpenRig directly instead')
  return display
}

/** Freeze declared spec/resources with OpenRig's own assembler, never by copying user HOME. */
export async function prepareLaunchReview(spec, cwd, config, snapshot, { execute = run, baseEnv = process.env, signal } = {}) {
  absolute(spec, 'spec')
  if (!/\.ya?ml$/i.test(spec) || !(await stat(spec)).isFile()) throw fail('invalid_spec', 'Verified launches require an existing absolute local YAML spec')
  if (String(snapshot.rigVersion || '').split(' ')[0] !== OPENRIG_VERSION) throw fail('unsupported_launch_review', `Frozen launch review requires OpenRig ${OPENRIG_VERSION}`)
  const parent = path.join(config.root, 'launches')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(path.join(parent, 'review-'))
  const archive = path.join(directory, 'review.rigbundle')
  try {
    const rig = await rigInvocation(snapshot.tools.rig, snapshot.tools.node)
    const options = { env: environment({ ...config, nodePath: snapshot.tools.node }, baseEnv), cwd: path.dirname(spec), timeout: 60000, ...(signal ? { signal } : {}) }
    parse(await execute(rig.file, [...rig.args, 'bundle', 'create', spec, '--output', archive, '--json'], options))
    if ((await stat(archive)).size > 50 * 1024 * 1024) throw fail('launch_review_failed', 'Launch bundle exceeds the 50 MiB review limit')
    const hash = digest(await readFile(archive))
    const inspection = parse(await execute(rig.file, [...rig.args, 'bundle', 'inspect', archive, '--json'], options))
    if (inspection.archiveHash !== hash) throw fail('launch_review_failed', 'Bundle inspection does not match the frozen bytes')
    const display = reviewDisplay(inspection, cwd, hash)
    for (const seat of display.seats) {
      const provider = seat.runtime === 'claude-code' ? 'claude' : seat.runtime
      if (provider !== 'terminal' && config.provider !== 'both' && provider !== config.provider) throw fail('provider_mismatch', 'The bundle contains a runtime outside your selected providers')
    }
    await chmod(archive, 0o400)
    const review = { directory, archive, hash, cwd, target: path.join(directory, 'materialized'), programPath: path.join(directory, 'launch.mjs'), rig, display, expires: Date.now() + 5 * 60 * 1000 }
    await writeFile(path.join(directory, 'review.json'), JSON.stringify(display, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return review
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function stageLaunchProgram(review) {
  if (Date.now() > review.expires || digest(await readFile(review.archive)) !== review.hash) throw fail('plan_stale', 'The frozen review expired or changed; prepare a new plan')
  await writeFile(review.programPath, launchProgram(review), { flag: 'wx', mode: 0o600 })
}

/** Self-contained program: its serialized source is copied only after confirmation. */
export async function launchMain(contract) {
  const fs = await import('node:fs')
  const crypto = await import('node:crypto')
  const child = await import('node:child_process')
  const readline = await import('node:readline')
  const verify = () => {
    if (Date.now() > contract.expires) throw new Error('Launch review expired. Prepare a new review.')
    if (crypto.createHash('sha256').update(fs.readFileSync(contract.archive)).digest('hex') !== contract.hash) throw new Error('Frozen bundle changed. Prepare a new review; no launch is allowed.')
  }
  const invoke = args => child.spawnSync(contract.rig.file, [...contract.rig.args, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, OPENRIG_NO_KERNEL: '1' }, timeout: 120000
  })
  const args = ['up', contract.archive, '--target', contract.target, '--cwd', contract.cwd]
  let input
  try {
    verify()
    console.log('FROZEN LAUNCH REVIEW — declared settings, not an OS sandbox guarantee')
    console.log(JSON.stringify(contract.display, null, 2))
    const preview = invoke([...args, '--plan', '--json'])
    if (preview.status !== 0 || preview.error) throw new Error('OpenRig preview failed; no launch was performed. Inspect this instance with OpenRig before retrying.')
    let previewData
    try { previewData = JSON.parse(preview.stdout) } catch { throw new Error('Preview returned invalid JSON; launch is blocked.') }
    if (previewData.status !== 'planned' || (previewData.errors || []).length) throw new Error('Preview did not return a complete successful plan; launch is blocked.')
    console.log('OpenRig preview completed. The archive, not the mutable source YAML, will be launched.')
    input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
    const answers = input[Symbol.asyncIterator]()
    if (contract.display.unverified.length) {
      process.stdout.write('Type ACCEPT UNVERIFIED SETTINGS to acknowledge the listed native/model/host uncertainties: ')
      if ((await answers.next()).value !== 'ACCEPT UNVERIFIED SETTINGS') throw new Error('Cancelled: unverified settings were not accepted.')
    }
    process.stdout.write('Type LAUNCH to execute this frozen bundle: ')
    if ((await answers.next()).value !== 'LAUNCH') throw new Error('Cancelled: no launch was requested.')
    verify()
    const result = invoke(args)
    process.stdout.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    if (result.status !== 0 || result.error) throw new Error('Launch did not report success. Inspect the daemon before retrying; some seats may already be running.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  } finally { input?.close() }
}

export const launchProgram = review => `(${launchMain.toString()})(${JSON.stringify(review)})`
