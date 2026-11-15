#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureTmux } from '../ensure-tmux.mjs'
import { requireIntelMac } from './settings.mjs'

export async function ensureIntelTmux(options = {}) {
  requireIntelMac(options.platform, options.arch)
  if (options.install) throw new Error('Intel preflight is verify-only; install tmux explicitly with your chosen package manager')
  const baseEnv = options.baseEnv || process.env
  // launchd runners do not source interactive shell profiles. Include the conventional
  // per-user executable directory as well as MacPorts without changing global PATH.
  const PATH = [baseEnv.PATH, '/opt/local/bin', baseEnv.HOME && path.join(baseEnv.HOME, '.local', 'bin')].filter(Boolean).join(path.delimiter)
  try { return await ensureTmux({ ...options, install: false, baseEnv: { ...baseEnv, PATH } }) }
  catch (error) {
    if (error.message.includes('functional tmux installation is mandatory')) {
      throw new Error('A functional tmux installation is mandatory for Intel CI. Provision tmux on the runner PATH, /opt/local/bin or $HOME/.local/bin; see docs/INTEL-CI.md. No automatic system installation was attempted.')
    }
    throw error
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Intel tmux preflight accepts no installation flags')
  console.log(JSON.stringify(await ensureIntelTmux(), null, 2))
}
