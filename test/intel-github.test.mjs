import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dispatchIntel, githubApi, validateRequest, QUEUE_MS, EXECUTION_MS, JOB, WORKER } from '../ci/intel/github-dispatch.mjs'

const request = { repo: 'owner/project', ref: 'refs/heads/main', sha: 'a'.repeat(40), requestId: '100-1', parentId: '100' }
const requiredLabels = ['self-hosted', 'macOS', 'X64', 'intel-mac-lab']
function fixture(options = {}) {
  let clock = 0, phase = options.hang ? 1 : 0, cancelled = false
  const calls = []
  const state = () => options.offline ? 0 : Math.min(phase, 2)
  const run = () => ({ id: 200, event: 'workflow_dispatch', head_sha: options.refDrift ? 'b'.repeat(40) : request.sha,
    display_title: options.wrongIdentity ? 'Another request' : 'Intel Mac worker ' + request.requestId,
    status: cancelled ? 'completed' : ['in_progress', 'in_progress', 'completed'][state()],
    conclusion: cancelled ? 'cancelled' : state() === 2 ? options.failed ? 'failure' : 'success' : null })
  return { calls, now: () => clock, elapsed: () => clock,
    delay: async ms => { clock += ms },
    api: async (method, route, body) => {
      calls.push({ method, route, body })
      if (route.endsWith('/dispatches')) return options.noId ? null : { workflow_run_id: 200 }
      if (method === 'POST' && route.endsWith('/force-cancel')) { if (!options.neverCancel) cancelled = true; return null }
      if (method === 'POST' && route.endsWith('/cancel')) { if (!options.forceCancel && !options.neverCancel) cancelled = true; return null }
      if (route.includes('/jobs?')) {
        if (options.apiFailure) throw new Error('GitHub API GET failed with HTTP 403')
        const current = state()
        const value = { total_count: 1, jobs: [{ name: JOB, status: ['queued', 'in_progress', 'completed'][current],
          conclusion: current === 2 ? options.failed ? 'failure' : 'success' : null,
          runner_id: current ? 7 : 0, runner_name: current ? 'lab-runner' : null,
          labels: options.wrongLabels ? ['self-hosted', 'macOS', 'ARM64'] : requiredLabels }] }
        if (!options.offline && !options.hang) phase++
        return value
      }
      return run()
    }
  }
}
const runFixture = (f, options = {}) => dispatchIntel(request, { ...f, queueMs: 20, executionMs: 30, pollMs: 10, ...options })

test('Intel GitHub controller requires exact identities and never dispatches malformed source', async () => {
  assert.equal(QUEUE_MS, 120000); assert.equal(EXECUTION_MS, 1800000)
  for (const changed of [{ repo: '../wrong' }, { sha: 'main' }, { requestId: 'wrong' }, { ref: 'main' }, { parentId: '' }]) {
    const f = fixture()
    await assert.rejects(dispatchIntel({ ...request, ...changed }, f), /Invalid/)
    assert.equal(f.calls.length, 0)
  }
})

test('offline or busy lab fails within a bounded queue wait even when the workflow says in_progress', async () => {
  const f = fixture({ offline: true })
  await assert.rejects(runFixture(f), /did not accept/)
  assert.equal(f.elapsed(), 20)
  assert.equal(f.calls.filter(c => c.route.endsWith('/dispatches')).length, 1)
  assert.equal(f.calls.filter(c => c.route.endsWith('/cancel')).length, 1)
})

test('Intel controller passes only a completed successful job claimed by the exact labelled runner', async () => {
  const f = fixture(), records = []
  const result = await runFixture(f, { onChild: async state => records.push(state) })
  assert.deepEqual(result, { childRunId: 200, conclusion: 'success', runner: 'lab-runner' })
  assert.equal(records[0].id, 200)
  const dispatch = f.calls[0]
  assert.equal(dispatch.route, '/actions/workflows/' + WORKER + '/dispatches')
  assert.deepEqual(dispatch.body.inputs, { request_id: request.requestId, source_sha: request.sha })
  assert.equal(f.calls.some(c => c.route.endsWith('/cancel')), false)
})

test('hanging Intel execution is cancelled and reported as failure rather than success or fallback', async () => {
  const f = fixture({ hang: true })
  await assert.rejects(runFixture(f), /execution exceeded/)
  assert.equal(f.elapsed(), 30)
  assert.ok(f.calls.some(c => c.route.endsWith('/cancel')))
})

test('wrong labels, failed workload and API errors fail closed', async () => {
  for (const options of [{ wrongLabels: true }, { failed: true }, { apiFailure: true }]) {
    const f = fixture(options)
    await assert.rejects(runFixture(f), /did not pass|HTTP 403/)
  }
})

test('a moved ref is a failure and its known dispatched child is still cancelled', async () => {
  const f = fixture({ refDrift: true })
  await assert.rejects(runFixture(f), /identity\/source mismatch/)
  assert.ok(f.calls.some(c => c.route.endsWith('/cancel')))
})

test('unrelated child identity is never cancelled by guessing', async () => {
  const f = fixture({ wrongIdentity: true })
  await assert.rejects(runFixture(f), /identity\/source mismatch/)
  assert.equal(f.calls.some(c => c.route.endsWith('/cancel')), false)
})

test('an unresponsive cancellation is force-cancelled; unverifiable cancellation remains a failure', async () => {
  const force = fixture({ offline: true, forceCancel: true })
  await assert.rejects(runFixture(force), /did not accept/)
  assert.ok(force.calls.some(c => c.route.endsWith('/force-cancel')))
  const stuck = fixture({ offline: true, neverCancel: true })
  await assert.rejects(runFixture(stuck), /cancellation remains unverified/)
})

test('ambiguous dispatch is never automatically repeated', async () => {
  const f = fixture({ noId: true })
  await assert.rejects(runFixture(f), /Do not redispatch automatically/)
  assert.equal(f.calls.length, 1)
})

test('GitHub API uses the direct child-ID version, bounded requests and no token-bearing diagnostics', async () => {
  let captured
  const api = githubApi(request.repo, 'private-token-fixture', async (url, options) => {
    captured = { url, options }
    return new Response(JSON.stringify({ workflow_run_id: 200 }), { status: 200 })
  })
  assert.equal((await api('POST', '/actions/workflows/worker.yml/dispatches', {})).workflow_run_id, 200)
  assert.equal(captured.options.headers['X-GitHub-Api-Version'], '2026-03-10')
  assert.equal(captured.options.redirect, 'error')
  assert.ok(captured.options.signal instanceof AbortSignal)
  const failed = githubApi(request.repo, 'private-token-fixture', async () => new Response('private response fixture', { status: 403 }))
  await assert.rejects(failed('GET', '/actions/runs/200'), error => {
    assert.equal(error.message, 'GitHub API GET failed with HTTP 403')
    assert.doesNotMatch(error.message, /private/)
    return true
  })
  assert.throws(() => githubApi(request.repo, ''), /Missing/)
})

test('manual workflows keep Intel lab permissions isolated and include a hosted watchdog with cleanup', async () => {
  const controller = await readFile(new URL('../.github/workflows/intel-mac-test.yml', import.meta.url), 'utf8')
  const worker = await readFile(new URL('../.github/workflows/intel-mac-worker.yml', import.meta.url), 'utf8')
  for (const source of [controller, worker]) {
    assert.match(source, /workflow_dispatch:/)
    assert.doesNotMatch(source, /pull_request|pull_request_target|schedule:|push:/)
    for (const action of source.matchAll(/uses: (actions\/[^\s]+)@([^\s]+)/g)) assert.match(action[2], /^[a-f0-9]{40}$/)
    assert.match(source, /persist-credentials: false/)
  }
  assert.match(controller, /runs-on: ubuntu-latest/)
  assert.match(controller, /actions: write/)
  assert.match(controller, /if: always\(\)/)
  assert.match(controller, /github-dispatch.mjs --cleanup/)
  assert.match(worker, /runs-on: \[self-hosted, macOS, X64, intel-mac-lab\]/)
  assert.match(worker, /timeout-minutes: 30/)
  assert.doesNotMatch(worker, /actions: write|secrets\./)
  assert.match(worker, /ref: \$\{\{ inputs.source_sha \}\}/)
  assert.match(worker, /ci\/intel\/run-ci.mjs --suite orca/)
})
