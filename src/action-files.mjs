import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { shellCommand } from './runtime.mjs'

// Orca terminal.create bounds command length. Store the already-reviewed command only after
// consuming its one-use confirmation; pass a short, quoted invocation to the terminal API.
export async function stageAction(root, command) {
  const actions = path.join(root, 'actions')
  await mkdir(actions, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(path.join(actions, 'action-'))
  const file = path.join(directory, 'run.sh')
  await writeFile(file, `#!/bin/sh\nexec ${command}\n`, { flag: 'wx', mode: 0o600 })
  return { command: shellCommand('/bin/sh', [file]), file }
}
