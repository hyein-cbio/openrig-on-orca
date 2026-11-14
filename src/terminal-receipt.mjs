import { run, shellCommand } from './runtime.mjs'

export function orcaCommand(env = process.env, platform = process.platform) {
  // Use this host/profile's CLI, never fall through to a different installation.
  return env.ORCA_CLI_COMMAND || (env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : platform === 'linux' ? 'orca-ide' : 'orca')
}

// Only reveals a known terminal. Never creates a second PTY or resends its command.
export async function revealTerminal(receipt, { execute = run, baseEnv = process.env, platform = process.platform } = {}) {
  const cli = orcaCommand(baseEnv, platform)
  const args = ['terminal', 'switch', '--terminal', receipt.terminalId, '--environment', 'local', '--json']
  // Keep a disposable/profile-specific Orca target when copied to another shell.
  const recoveryCommand = baseEnv.ORCA_USER_DATA_PATH
    ? shellCommand('/usr/bin/env', [`ORCA_USER_DATA_PATH=${baseEnv.ORCA_USER_DATA_PATH}`, cli, ...args])
    : shellCommand(cli, args)
  const pending = { ...receipt, visibility: 'unverified', recoveryCommand }
  try {
    const invoke = async argv => {
      const result = await execute(cli, argv, { env: baseEnv, timeout: 4000 })
      if (!result.ok) throw new Error('CLI unavailable')
      const data = JSON.parse(result.stdout)
      if (!data.ok) throw new Error('CLI refused')
      return data
    }
    const showArgs = ['terminal', 'show', '--terminal', receipt.terminalId, '--environment', 'local', '--json']
    const before = await invoke(showArgs)
    let worktreeId = receipt.workspaceId
    if (worktreeId.startsWith('identity:')) {
      // workspace.list uses identity selectors, while terminal.show returns a legacy
      // repo::path ID. Resolve the exact identity; matching only a path is ambiguous.
      const resolved = await invoke(['worktree', 'show', '--worktree', worktreeId, '--environment', 'local', '--json'])
      const workspace = resolved.result?.worktree
      if (resolved._meta?.runtimeId !== before._meta?.runtimeId || workspace?.identity?.key !== worktreeId.slice('identity:'.length) || workspace.identity.executionHostId !== 'local' || typeof workspace.id !== 'string') return { ...pending, visibilityDetail: 'The destination workspace identity could not be verified.' }
      worktreeId = workspace.id
    }
    const matches = terminal => terminal?.handle === receipt.terminalId && terminal.worktreeId === worktreeId && terminal.connected === true
    if (!before._meta?.runtimeId || !matches(before.result?.terminal)) return { ...pending, visibilityDetail: 'The terminal could not be matched to its destination workspace.' }
    const switched = await invoke(args)
    if (switched.result?.focus?.handle !== receipt.terminalId || switched.result.focus.worktreeId !== worktreeId || switched.result.focus.navigated !== true) return { ...pending, visibilityDetail: 'Orca did not confirm navigation to the existing terminal.' }
    const after = await invoke(showArgs)
    if (before._meta?.runtimeId !== after._meta?.runtimeId) return { ...pending, visibilityDetail: 'The Orca runtime changed during verification.' }
    if (matches(after.result?.terminal) && after.result.terminal.orphaned === false) return { ...pending, visibility: 'shown', visibilityDetail: 'Orca confirmed navigation and a connected terminal tab.' }
  } catch { return { ...pending, visibilityDetail: 'The Orca CLI could not complete view verification. Use the recovery command below; do not rerun the original action.' } }
  return { ...pending, visibilityDetail: 'The terminal still has no verified tab connection.' }
}

export async function createTerminalView(orca, target, title, command, options = {}) {
  const result = await orca.host.call('terminal.create', { workspaceId: target.id, title, command })
  const owned = { terminalId: result.terminalId, workspaceId: target.id, workspaceName: target.name, title }
  const receipt = await persistTerminalReceipt(orca.storage, `terminal:${result.terminalId}`, owned, owned)
  return revealTerminal(receipt, options)
}

// Recording metadata is secondary to an already accepted terminal operation.
export async function persistTerminalReceipt(storage, key, value, receipt) {
  try { await storage.set(key, value); return receipt }
  catch {
    const warning = 'The terminal was created, but its metadata could not be saved. Inspect that terminal before retrying; recovery after a worker restart may be unavailable.'
    return { ...receipt, warning: [receipt.warning, warning].filter(Boolean).join(' ') }
  }
}
