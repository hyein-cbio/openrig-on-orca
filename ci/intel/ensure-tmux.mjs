#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureTmux } from '../ensure-tmux.mjs'
import { requireIntelMac } from './settings.mjs'

export async function ensureIntelTmux(options = {}) {
  requireIntelMac(options.platform, options.arch)
  if (options.install) throw new Error('Intel preflight is verify-only; install tmux explicitly with your chosen package manager')
  const baseEnv = options.baseEnv || process.env
  const PATH = [baseEnv.PATH, '/opt/local/bin'].filter(Boolean).join(path.delimiter)
  return ensureTmux({ ...options, install: false, baseEnv: { ...baseEnv, PATH } })
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Intel tmux preflight accepts no installation flags')
  console.log(JSON.stringify(await ensureIntelTmux(), null, 2))
}
