#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
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
// Never blanket-ignore the baseline manifest or hexadecimal secrets. Only an exact JSON
// digest entry whose referenced bytes independently hash to it is a verified false positive.
export async function verifiedBaselineDigest(root, finding, { history = false, base = '', execute = exec } = {}) {
  try {
    let file = String(finding.File || '')
    if (base && file.startsWith(base + path.sep)) file = path.relative(base, file)
    if (finding.RuleID !== 'generic-api-key' || file !== 'test/fixtures/apple-silicon-baseline.json') return false
    const commit = finding.Commit, line = Number(finding.StartLine)
    if (!Number.isSafeInteger(line) || line < 1 || (finding.EndLine !== undefined && Number(finding.EndLine) !== line) || (history && !/^[a-f0-9]{40}$/.test(commit || ''))) return false
    const bytes = async relative => {
      if (!/^[A-Za-z0-9_./-]+$/.test(relative) || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Unsafe digest reference')
      if (history) return (await execute('git', ['show', `${commit}:${relative}`], { cwd: root, env: cleanCiEnvironment(process.env), encoding: 'buffer', timeout: 10000, maxBuffer: 16 * 1024 * 1024 })).stdout
      const target = await realpath(path.resolve(root, relative)), canonical = await realpath(root)
      if (!target.startsWith(canonical + path.sep)) throw new Error('Escaped digest reference')
      return readFile(target)
    }
    const manifest = (await bytes(file)).toString('utf8'), entry = /^\s*"([A-Za-z0-9_./-]+)": "([a-f0-9]{64})",?\s*$/.exec(manifest.split('\n')[line - 1] || '')
    if (!entry || JSON.parse(manifest).files?.[entry[1]] !== entry[2]) return false
    return createHash('sha256').update(await bytes(entry[1])).digest('hex') === entry[2]
  } catch { return false }
}
export async function checkSecrets(root, output, { execute = exec, binary = 'gitleaks', bootstrap = false } = {}) {
  await mkdir(output, { recursive: true })
  const temporary = await mkdtemp(path.join(tmpdir(), 'openrig-secret-scan-'))
  const result = { ok: false, files: 0, findings: [], historyFindings: [], worktreeFindings: [], verifiedBaselineHashes: { history: 0, worktree: 0 } }
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
      const raw = JSON.parse(await readFile(report, 'utf8'))
      if (!Array.isArray(raw)) throw new Error('Invalid scanner report')
      const remaining = []
      for (const item of raw) {
        if (await verifiedBaselineDigest(root, item, { history: name === 'history', base, execute })) result.verifiedBaselineHashes[name]++
        else remaining.push(item)
      }
      const findings = redactLocations(remaining, base)
      return { ok: !findings.length && (status === 0 || (status === 1 && raw.length > 0 && remaining.length === 0)), findings }
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
