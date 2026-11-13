#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { gitCandidates, inspectText, scanGit } from '../scripts/scan-secrets.mjs'
import { cleanCiEnvironment } from '../scripts/ci-support.mjs'
import { installGitleaks } from './bootstrap-gitleaks.mjs'
const exec = promisify(execFile)

export function redactLocations(findings, base = '') {
  if (!Array.isArray(findings)) throw new Error('Invalid secret scanner report')
  return findings.map(item => {
    let file = String(item.File || '')
    if (base && file.startsWith(base + path.sep)) file = path.relative(base, file)
    else if (path.isAbsolute(file)) file = path.basename(file)
    if (inspectText(file, '').length) file = '<redacted-filename>'
    let rule = String(item.RuleID || '')
    if (inspectText(rule, '').length) rule = '<redacted-rule>'
    return { file, line: Number.isSafeInteger(Number(item.StartLine)) ? Number(item.StartLine) : 0, rule }
  })
}
export async function checkSecrets(root, output, { execute = exec, binary = 'gitleaks', bootstrap = false } = {}) {
  await mkdir(output, { recursive: true })
  const temporary = await mkdtemp(path.join(tmpdir(), 'openrig-secret-scan-'))
  const result = { ok: false, files: 0, findings: [], historyFindings: [], worktreeFindings: [] }
  try {
    const env = cleanCiEnvironment(process.env)
    if (bootstrap) binary = await installGitleaks(temporary, { execute, env })
    const current = await scanGit(root)
    result.files = current.files; result.findings = current.findings
    async function scan(args, name, base) {
      const report = path.join(temporary, `${name}.json`)
      let status = 0
      try { await execute(binary, [...args, '--redact=100', '--no-banner', '--report-format=json', `--report-path=${report}`], { cwd: root, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }) }
      catch (error) { status = error.code }
      if (status !== 0 && status !== 1) throw new Error('Secret scanner did not complete')
      const findings = redactLocations(JSON.parse(await readFile(report, 'utf8')), base)
      return { ok: status === 0 && !findings.length, findings }
    }
    const history = await scan(['git', root, '--log-opts=--all'], 'history', root)
    result.historyFindings = history.findings
    // Scan untracked first-commit candidates too, but never copy ignored dependency/profile trees.
    const candidates = path.join(temporary, 'candidates'); await mkdir(candidates)
    for (const file of await gitCandidates(root)) {
      const source = path.resolve(root, file), target = path.resolve(candidates, file)
      if (!source.startsWith(path.resolve(root) + path.sep) || !target.startsWith(candidates + path.sep)) throw new Error('Unsafe candidate path')
      const info = await lstat(source)
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Candidate requires manual review')
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, await readFile(source), { flag: 'wx', mode: 0o600 })
    }
    const worktree = await scan(['dir', candidates], 'worktree', candidates)
    result.worktreeFindings = worktree.findings
    result.ok = history.ok && worktree.ok && !result.findings.length
  } catch { result.error = 'Secret scanning was incomplete. Raw scanner output was withheld; publication is blocked.' }
  finally {
    await rm(temporary, { recursive: true, force: true })
    await writeFile(path.join(output, 'locations.json'), JSON.stringify(result, null, 2) + '\n')
  }
  return result
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkSecrets(process.cwd(), path.resolve('ci-results/secrets'), { bootstrap: process.argv.includes('--bootstrap') })
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.ok ? 0 : 1
}
