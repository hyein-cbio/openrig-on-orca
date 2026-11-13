#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile)
const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ['provider-key', /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{24,}\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['credential-url', /https?:\/\/[^\s/@:]+:[^\s/@]+@/g],
  ['literal-secret', /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|auth[_-]?token)["']?\s*[=:]\s*["']([^"'\r\n]{20,})["']/gi]
]

export function sensitiveFilename(file) {
  const name = path.basename(file)
  return (/^\.env(?:\.|$)/i.test(name) && !/\.(?:example|sample|template)$/i.test(name)) ||
    ['.npmrc', '.netrc', 'auth.json', 'credentials.json'].includes(name.toLowerCase()) || /\.(?:key|p12|pfx|keystore|db|sqlite3?|rigbundle)$/i.test(name)
}
export function inspectText(text, file) {
  const findings = []
  for (const [rule, regex] of rules) {
    regex.lastIndex = 0
    for (const match of text.matchAll(regex)) {
      if (rule === 'literal-secret' && /^(?:<[^>]+>|\$\{[^}]+\}|YOUR_[A-Z_]+|REPLACE_[A-Z_]+)$/.test(match[1])) continue
      findings.push({ file, line: text.slice(0, match.index).split('\n').length, rule })
    }
  }
  return findings // Never return the matched credential or source line.
}
export async function gitCandidates(root) {
  const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return [...new Set(stdout.split('\0').filter(Boolean))]
}
export async function scanGit(root) {
  const files = await gitCandidates(root)
  const findings = []
  for (const file of files) {
    const resolved = path.resolve(root, file)
    if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('Secret scan encountered an unsafe path')
    const filenameFindings = inspectText(file, '<redacted-filename>')
    if (filenameFindings.length) { findings.push(...filenameFindings); continue }
    if (sensitiveFilename(file)) { findings.push({ file, line: 0, rule: 'sensitive-filename' }); continue }
    const info = await lstat(resolved)
    if (!info.isFile() || info.size > 16 * 1024 * 1024) { findings.push({ file, line: 0, rule: 'requires-manual-review' }); continue }
    findings.push(...inspectText((await readFile(resolved)).toString('utf8'), file))
  }
  return { files: files.length, findings }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await scanGit(process.cwd())
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.findings.length ? 1 : 0
  } catch { console.error('Secret scan could not inspect the complete Git candidate set. Publication is blocked.'); process.exitCode = 1 }
}
