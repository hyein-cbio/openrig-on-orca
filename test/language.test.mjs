import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const generated = new Set(['.git', '.cocoindex_code', '.orca', '.sandbox', 'node_modules', 'coverage', 'ci-results', 'test-reports'])
const hangul = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/u
const textExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.jsonl', '.md', '.yaml', '.yml', '.txt', '.sh', '.toml', '.xml', '.html', '.css'])

test('repository-owned text and filenames contain no Hangul', async () => {
  const violations = []
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (generated.has(entry.name) || entry.name === '.DS_Store') continue
      const file = path.join(directory, entry.name)
      const relative = path.relative(root, file)
      if (hangul.test(entry.name)) violations.push(`${relative}: filename`)
      if (entry.isDirectory()) { await inspect(file); continue }
      if (!entry.isFile()) continue // Do not follow symlinks into external content.
      const bytes = await readFile(file)
      let content
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch {
        if (textExtensions.has(path.extname(entry.name)) || ['.gitignore', '.gitattributes'].includes(entry.name)) {
          violations.push(`${relative}: expected UTF-8 text`)
        }
        continue // Images and other binary assets are not text documents.
      }
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (hangul.test(line)) violations.push(`${relative}:${index + 1}`)
      }
    }
  }
  await inspect(root)
  assert.deepEqual(violations, [], 'Use English in repository-owned files; generated dependencies and local state are excluded')
})
