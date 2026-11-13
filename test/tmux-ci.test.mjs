import test from 'node:test'
import assert from 'node:assert/strict'
import { access, rm } from 'node:fs/promises'
import path from 'node:path'
import { ensureTmux } from '../ci/ensure-tmux.mjs'

function fixture(options = {}) {
  let available = options.existing ?? false
  const calls = []
  return {
    calls,
    args: {
      install: true, platform: 'darwin', arch: 'arm64',
      baseEnv: { PATH: '/selected-node/bin:/usr/bin:/bin', HOME: '/fixture-home', CIRCLECI: 'true', TMUX: '/personal/server', OPENAI_API_KEY: 'not-forwarded' },
      find: async name => name === 'tmux' ? available ? '/fixture/tmux' : null : name === 'brew' ? '/fixture/brew' : null,
      execute: async (file, args, execution) => {
        calls.push({ file, args, ...execution })
        if (file === '/fixture/brew') {
          available = !options.stillMissing
          return { ok: !(options.installCode || options.interrupted), code: options.interrupted ? 0 : options.installCode || 0, stdout: '', stderr: '' }
        }
        if (args.includes('-V')) return { ok: !options.badVersion, stdout: options.badVersion ? '' : 'tmux 3.8\n' }
        if (args.includes('new-session')) return { ok: !options.badSession, stdout: '' }
        if (args.includes('display-message')) return { ok: true, stdout: options.badDisplay ? 'wrong-session' : 'ci-probe\n' }
        if (args.includes('kill-server')) return { ok: !options.badCleanup, stdout: '' }
        throw new Error('Unexpected probe command')
      }
    }
  }
}
const socketFor = f => f.calls.find(call => call.args.includes('new-session')).args[3]

test('a functional existing tmux is reused without brew and never probes the personal server', async () => {
  const f = fixture({ existing: true })
  const report = await ensureTmux(f.args)
  assert.equal(report.installAttempted, false)
  assert.equal(report.socketProbePassed, true)
  assert.equal(f.calls.some(call => call.file === '/fixture/brew'), false)
  const socket = socketFor(f)
  assert.ok(socket.startsWith('/tmp/openrig-tmux-check-'))
  for (const call of f.calls) {
    assert.equal(call.env.TMUX, undefined); assert.equal(call.env.OPENAI_API_KEY, undefined)
    if (!call.args.includes('-V')) assert.equal(call.args[call.args.indexOf('-S') + 1], socket)
  }
  const creation = f.calls.find(call => call.args.includes('new-session'))
  assert.deepEqual(creation.args.slice(0, 2), ['-f', '/dev/null'])
  assert.ok(creation.env.PATH.startsWith('/selected-node/bin:'))
  await assert.rejects(access(path.dirname(socket)))
})
test('a missing tmux is explicitly installed and then functionally verified', async () => {
  const f = fixture()
  const report = await ensureTmux(f.args)
  assert.equal(report.installAttempted, true)
  assert.equal(report.installExitCode, 0)
  assert.equal(report.recoveredInstallFailure, false)
  const install = f.calls.find(call => call.file === '/fixture/brew')
  assert.deepEqual(install.args, ['install', 'tmux'])
  assert.equal(install.env.HOMEBREW_NO_AUTO_UPDATE, '1')
  assert.equal(install.env.HOMEBREW_NO_INSTALL_CLEANUP, '1')
  assert.equal(report.socketProbePassed, true)
})
test('Homebrew post-install exit 1 is accepted only after tmux session and cleanup succeed', async () => {
  const f = fixture({ installCode: 1 })
  const report = await ensureTmux(f.args)
  assert.equal(report.recoveredInstallFailure, true)
  assert.equal(report.installExitCode, 1)
  assert.equal(report.socketProbePassed, true)
  assert.ok(f.calls.some(call => call.args.includes('display-message')))
  assert.ok(f.calls.some(call => call.args.includes('kill-server')))
  const broken = fixture({ installCode: 1, badVersion: true })
  await assert.rejects(ensureTmux(broken.args), /tmux cannot execute/)
})
test('brew success or failure cannot substitute for the required tmux executable', async () => {
  for (const installCode of [0, 1]) {
    const f = fixture({ stillMissing: true, installCode })
    await assert.rejects(ensureTmux(f.args), /tmux is still missing/)
  }
})
test('verify-only mode refuses missing tmux without silently installing anything', async () => {
  const f = fixture()
  await assert.rejects(ensureTmux({ ...f.args, install: false }), /tmux installation is mandatory/)
  assert.equal(f.calls.length, 0)
})
test('an existing non-executable tmux fails before any replacement or live tests', async () => {
  const f = fixture({ existing: true, badVersion: true })
  await assert.rejects(ensureTmux(f.args), /tmux cannot execute/)
  assert.equal(f.calls.some(call => call.file === '/fixture/brew'), false)
})
test('a version string alone is insufficient when detached sessions fail', async () => {
  for (const options of [{ badSession: true }, { badDisplay: true }]) {
    const f = fixture({ existing: true, ...options })
    await assert.rejects(ensureTmux(f.args), /tmux could not create|tmux session verification failed/)
    assert.ok(f.calls.some(call => call.args.includes('kill-server')))
    await assert.rejects(access(path.dirname(socketFor(f))))
  }
})
test('an interrupted brew process is not treated as a benign post-install failure', async () => {
  for (const options of [{ interrupted: true }, { installCode: 130 }, { installCode: 'ENOENT' }]) {
    const f = fixture(options)
    await assert.rejects(ensureTmux(f.args), /did not complete normally/)
    assert.equal(f.calls.some(call => call.args.includes('-V')), false)
  }
})
test('failed cleanup is a failure and retains the private socket directory for diagnosis', async () => {
  const f = fixture({ existing: true, badCleanup: true })
  try {
    await assert.rejects(ensureTmux(f.args), /tmux probe cleanup failed/)
    await access(path.dirname(socketFor(f)))
  } finally { await rm(path.dirname(socketFor(f)), { recursive: true, force: true }) }
})
test('automatic Homebrew installation is refused outside the explicit managed CI context', async () => {
  const f = fixture()
  await assert.rejects(ensureTmux({ ...f.args, baseEnv: { PATH: '/bin' } }), /limited to the managed/)
  assert.equal(f.calls.length, 0)
})
