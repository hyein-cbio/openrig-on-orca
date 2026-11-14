import test from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalView, orcaCommand, revealTerminal } from '../src/terminal-receipt.mjs'

const receipt = { terminalId: 'term-owned', workspaceId: 'workspace', workspaceName: 'Sandbox', title: 'Install' }
const show = orphaned => ({ ok: true, result: { terminal: { handle: receipt.terminalId, worktreeId: receipt.workspaceId, connected: true, orphaned } }, _meta: { runtimeId: 'same-profile' } })
const switched = { ok: true, result: { focus: { handle: receipt.terminalId, worktreeId: receipt.workspaceId, navigated: true } } }
const result = data => ({ ok: true, stdout: JSON.stringify(data) })

function executor(responses) {
  const calls = []
  return {
    calls,
    execute: async (file, args, options) => {
      calls.push({ file, args, options })
      const next = responses.shift()
      if (next instanceof Error) throw next
      assert.ok(next, 'Unexpected extra CLI call')
      return result(next)
    }
  }
}

test('orphaned terminal is switched and verified without creating or resending anything', async () => {
  const cli = executor([show(true), switched, show(false)])
  const env = { ORCA_CLI_COMMAND: '/custom/orca cli', ORCA_USER_DATA_PATH: '/isolated/profile', ORCA_ENVIRONMENT: 'remote' }
  const view = await revealTerminal(receipt, { execute: cli.execute, baseEnv: env })
  assert.equal(view.visibility, 'shown')
  assert.deepEqual(cli.calls.map(c => c.args.slice(0, 2)), [['terminal', 'show'], ['terminal', 'switch'], ['terminal', 'show']])
  for (const call of cli.calls) {
    assert.equal(call.file, env.ORCA_CLI_COMMAND)
    assert.equal(call.options.env.ORCA_USER_DATA_PATH, '/isolated/profile')
    assert.deepEqual(call.args.slice(-3), ['--environment', 'local', '--json'])
    assert.ok(call.args.includes(receipt.terminalId))
  }
  assert.doesNotMatch(view.recoveryCommand, /create|send|run\.sh/)
})

test('real host identity selectors resolve to the legacy terminal workspace ID before switching', async () => {
  const owned = { ...receipt, workspaceId: 'identity:wt2:local:instance-1' }
  const resolved = { ok: true, result: { worktree: { id: receipt.workspaceId, identity: { key: 'wt2:local:instance-1', executionHostId: 'local' } } }, _meta: { runtimeId: 'same-profile' } }
  const cli = executor([show(true), resolved, switched, show(false)])
  const view = await revealTerminal(owned, { execute: cli.execute })
  assert.equal(view.visibility, 'shown')
  assert.equal(view.workspaceId, owned.workspaceId, 'Keep the approved identity selector in the receipt')
  assert.deepEqual(cli.calls[1].args, ['worktree', 'show', '--worktree', owned.workspaceId, '--environment', 'local', '--json'])
  assert.deepEqual(cli.calls.map(c => c.args.slice(0, 2)), [['terminal', 'show'], ['worktree', 'show'], ['terminal', 'switch'], ['terminal', 'show']])
})

test('wrong identity, remote scope or changed profile cannot be resolved by path guessing', async () => {
  const owned = { ...receipt, workspaceId: 'identity:wt2:local:instance-1' }
  const matching = { id: receipt.workspaceId, identity: { key: 'wt2:local:instance-1', executionHostId: 'local' } }
  for (const resolved of [
    { ok: true, result: { worktree: { ...matching, identity: { key: 'wt2:local:other', executionHostId: 'local' } } }, _meta: { runtimeId: 'same-profile' } },
    { ok: true, result: { worktree: { ...matching, identity: { key: 'wt2:local:instance-1', executionHostId: 'remote' } } }, _meta: { runtimeId: 'same-profile' } },
    { ok: true, result: { worktree: matching }, _meta: { runtimeId: 'other-profile' } }
  ]) {
    const cli = executor([show(true), resolved])
    const view = await revealTerminal(owned, { execute: cli.execute })
    assert.equal(view.visibility, 'unverified')
    assert.equal(cli.calls.length, 2)
    assert.match(view.visibilityDetail, /workspace identity/)
  }
})

test('wrong workspace or disconnected handle is never switched', async () => {
  for (const terminal of [
    { ...show(true).result.terminal, worktreeId: 'other' },
    { ...show(true).result.terminal, handle: 'term-other' },
    { ...show(true).result.terminal, connected: false }
  ]) {
    const cli = executor([{ ok: true, result: { terminal } }])
    const view = await revealTerminal(receipt, { execute: cli.execute, baseEnv: {} })
    assert.equal(view.visibility, 'unverified')
    assert.equal(cli.calls.length, 1)
  }
})

test('unproven navigation, orphaned readback and runtime changes are not reported as shown', async () => {
  const cases = [
    [show(true), { ok: true, result: { focus: { ...switched.result.focus, navigated: false } } }],
    [show(true), switched, show(true)],
    [show(true), switched, { ...show(false), _meta: { runtimeId: 'different-profile' } }]
  ]
  for (const responses of cases) {
    const cli = executor(responses)
    const view = await revealTerminal(receipt, { execute: cli.execute })
    assert.equal(view.visibility, 'unverified')
    assert.match(view.recoveryCommand, /terminal.*switch/)
  }
})

test('CLI errors retain the accepted receipt and do not try another CLI or rerun the action', async () => {
  const calls = []
  const view = await revealTerminal(receipt, {
    baseEnv: { ORCA_CLI_COMMAND: '/missing/exact-cli' },
    execute: async (file, args) => { calls.push({ file, args }); throw new Error('profile unavailable') }
  })
  assert.equal(view.terminalId, receipt.terminalId)
  assert.equal(view.visibility, 'unverified')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, '/missing/exact-cli')
})

test('terminal creation and metadata failure still return one recoverable receipt', async () => {
  const calls = []
  const orca = {
    host: { call: async (method, params) => { calls.push({ method, params }); return { terminalId: receipt.terminalId } } },
    storage: { set: async () => { throw new Error('storage unavailable') } }
  }
  const view = await createTerminalView(orca, { id: 'workspace', name: 'Sandbox' }, 'Install', 'approved-command', {
    execute: async () => ({ ok: false, stdout: '' })
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'terminal.create')
  assert.equal(calls[0].params.command, 'approved-command')
  assert.equal(view.terminalId, receipt.terminalId)
  assert.equal(view.visibility, 'unverified')
  assert.match(view.warning, /metadata could not be saved/)
  assert.ok(view.recoveryCommand)
})

test('CLI selection respects explicit/dev hosts and avoids Linux screen reader', () => {
  assert.equal(orcaCommand({ ORCA_CLI_COMMAND: '/exact' }, 'linux'), '/exact')
  assert.equal(orcaCommand({ ORCA_DEV_REPO_ROOT: '/dev' }, 'darwin'), 'orca-dev')
  assert.equal(orcaCommand({}, 'linux'), 'orca-ide')
  assert.equal(orcaCommand({}, 'darwin'), 'orca')
})
