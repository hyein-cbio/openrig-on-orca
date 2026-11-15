#!/usr/bin/env node
// GitHub-hosted controller. Never waits for its own self-hosted runner.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const WORKER = 'intel-mac-worker.yml'
export const JOB = 'Intel Mac lab tests'
export const QUEUE_MS = 120000
export const EXECUTION_MS = 30 * 60 * 1000
const labels = ['self-hosted', 'macos', 'x64', 'intel-mac-lab']
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const validRepo = value => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value || '') && !value.split('/').some(part => part === '.' || part === '..')

export function validateRequest({ repo, ref, sha, requestId, parentId }) {
  if (!validRepo(repo) ||
      !/^refs\/(heads|tags)\/.+/.test(ref || '') || /[\r\n\0]/.test(ref) ||
      !/^[a-f0-9]{40}$/.test(sha || '') || !/^\d+-\d+$/.test(requestId || '') ||
      !/^\d+$/.test(String(parentId || ''))) throw new Error('Invalid Intel controller identity/source')
}
function verifyChild(run, state, checkSource = true) {
  if (run.id !== state.id || run.id === Number(state.parentId) || run.event !== 'workflow_dispatch' ||
      run.path !== '.github/workflows/' + WORKER || (checkSource && run.head_sha !== state.sha)) {
    throw new Error('Worker identity/source mismatch (ID, event, workflow path or source); refusing to operate on an unverified run')
  }
  if (run.display_title === 'Intel Mac worker ' + state.requestId) return true
  // GitHub initially exposes the workflow name before evaluating its run-name inputs.
  // Only that known placeholder may settle; a different request must still fail closed.
  if (run.display_title === 'Intel Mac worker') return false
  throw new Error('Worker identity/source mismatch (request title); refusing to operate on an unverified run')
}

async function verifiedChild(api, state, { delay, checkSource = true }) {
  for (let attempt = 0; attempt < 10; attempt++) {
    let run
    try { run = await api('GET', '/actions/runs/' + state.id) }
    catch (error) { if (error.status !== 404) throw error }
    if (run && verifyChild(run, state, checkSource)) return run
    if (attempt < 9) await delay(2000)
  }
  throw new Error('Worker metadata did not become verifiable within the bounded publication wait; inspect child run ' + state.id)
}
function claimed(job) {
  return job && ['in_progress', 'completed'].includes(job.status) &&
    Number.isSafeInteger(job.runner_id) && job.runner_id > 0 && Boolean(job.runner_name) &&
    labels.every(label => (job.labels || []).map(value => value.toLowerCase()).includes(label))
}

export async function cancelChild(api, state, { delay = pause } = {}) {
  const route = '/actions/runs/' + state.id
  // A ref drift fails the experiment but must not leave its owned child queued.
  const current = await verifiedChild(api, state, { delay, checkSource: false })
  if (current.status === 'completed') return
  try { await api('POST', route + '/cancel') } catch (error) { if (error.status !== 409) throw error }
  for (let attempt = 0; attempt < 6; attempt++) {
    const run = await verifiedChild(api, state, { delay, checkSource: false })
    if (run.status === 'completed') return
    if (attempt === 2) {
      try { await api('POST', route + '/force-cancel') } catch (error) { if (error.status !== 409) throw error }
    }
    await delay(2000)
  }
  throw new Error('Worker cancellation remains unverified; inspect the child run before retrying')
}

export async function dispatchIntel(request, { api, now = Date.now, delay = pause,
  queueMs = QUEUE_MS, executionMs = EXECUTION_MS, pollMs = 10000, onChild = async () => {} } = {}) {
  validateRequest(request)
  if (![queueMs, executionMs, pollMs].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid controller deadlines')
  const queuedAt = now()
  // API 2026-03-10 returns the child ID directly. Never replay an ambiguous dispatch.
  const dispatched = await api('POST', '/actions/workflows/' + WORKER + '/dispatches',
    { ref: request.ref, inputs: { request_id: request.requestId, source_sha: request.sha } })
  const state = { ...request, id: dispatched?.workflow_run_id }
  if (!Number.isSafeInteger(state.id) || state.id <= 0 || state.id === Number(request.parentId)) {
    throw new Error('Dispatch returned no safe child ID; outcome is unverified. Do not redispatch automatically')
  }
  let startedAt
  try {
    await onChild(state)
    for (;;) {
      const run = await verifiedChild(api, state, { delay })
      const jobs = await api('GET', '/actions/runs/' + state.id + '/jobs?filter=latest&per_page=100')
      const matching = jobs.jobs?.filter(job => job.name === JOB) || []
      if (matching.length > 1 || jobs.total_count > 100) throw new Error('Worker job identity is ambiguous')
      const job = matching[0]
      if (claimed(job) && startedAt === undefined) startedAt = now()
      if (run.status === 'completed') {
        if (run.conclusion !== 'success' || job?.status !== 'completed' || job.conclusion !== 'success' || !claimed(job)) {
          throw new Error('Intel worker did not pass on the required labelled runner: ' + String(run.conclusion))
        }
        return { childRunId: state.id, conclusion: 'success', runner: job.runner_name }
      }
      if (startedAt === undefined && now() - queuedAt >= queueMs) throw new Error('intel-mac-lab did not accept the job within 120 seconds; refusing to wait indefinitely')
      if (startedAt !== undefined && now() - startedAt >= executionMs) throw new Error('intel-mac-lab execution exceeded 30 minutes')
      await delay(pollMs)
    }
  } catch (error) {
    try { await cancelChild(api, state, { delay }) }
    catch (cleanupError) { throw new Error(error.message + '; ' + cleanupError.message) }
    throw error
  }
}

export function githubApi(repo, token, fetcher = fetch) {
  if (!token) throw new Error('Missing GitHub Actions token; cannot safely dispatch/cancel a worker')
  if (!validRepo(repo)) throw new Error('Invalid repository identity')
  return async (method, route, body) => {
    const response = await fetcher('https://api.github.com/repos/' + repo + route, {
      method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    if (!response.ok) throw Object.assign(new Error('GitHub API ' + method + ' failed with HTTP ' + response.status), { status: response.status })
    return response.status === 204 ? null : response.json()
  }
}

async function main(argv) {
  if (argv.some(value => value !== '--cleanup') || argv.length > 1) throw new Error('Only --cleanup is supported')
  const request = { repo: process.env.GITHUB_REPOSITORY, ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA,
    requestId: process.env.GITHUB_RUN_ID + '-' + process.env.GITHUB_RUN_ATTEMPT, parentId: process.env.GITHUB_RUN_ID }
  validateRequest(request)
  const directory = path.resolve('ci-results/intel-dispatch'), stateFile = path.join(directory, 'child.json')
  const api = githubApi(request.repo, process.env.GH_TOKEN)
  await mkdir(directory, { recursive: true })
  if (argv.includes('--cleanup')) {
    let state
    try { state = JSON.parse(await readFile(stateFile, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (state.repo !== request.repo || state.parentId !== request.parentId || state.requestId !== request.requestId || state.sha !== request.sha ||
        !Number.isSafeInteger(state.id) || state.id <= 0) throw new Error('Unowned child record; no cancellation attempted')
    await cancelChild(api, state)
    return
  }
  let result
  try {
    result = await dispatchIntel(request, { api, onChild: async state => {
      await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' })
      console.log('Intel worker: https://github.com/' + request.repo + '/actions/runs/' + state.id)
    } })
  } catch (error) {
    result = { conclusion: 'failure', error: error.message }
    throw error
  } finally { await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n') }
  console.log(JSON.stringify(result))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)) }
  catch (error) { console.error('::error::' + error.message.replace(/[\r\n]/g, ' ')); process.exitCode = 1 }
}
