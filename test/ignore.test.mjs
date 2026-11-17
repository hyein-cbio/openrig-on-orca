import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)

test('ignore private runtime/test state but retain intentional source and prebuilt viewer assets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openrig-ignore-'))
  try {
    const rules = await readFile(new URL('../.gitignore', import.meta.url), 'utf8')
    assert.equal(rules.includes('.cocoindex_code'), false, 'The global ignore owns the code index policy')
    await writeFile(path.join(directory, '.gitignore'), rules)
    await exec('git', ['init', '-q'], { cwd: directory })
    const ignored = ['.env', '.env.local', '.npmrc', 'auth.json', 'tokens.json', 'cookies.json', 'storage-state-session.json',
      '.orca/profile/state.json', '.sandbox/runtime/rig.mjs', 'node_modules', 'node_modules/library/index.js', 'ci-results/report.xml', 'test-reports/run.xml',
      'profiles/account.json', 'browser-profiles/session.json', 'artifacts/private.txt', 'screenshots/personal.png', 'recordings/session.mp4',
      'runtime/rig.mjs', 'providers/login.json', 'instance/daemon.json', 'actions/private/run.sh', 'launches/review/manifest.json',
      'debug.log', 'debug.log.1', 'daemon.pid', 'daemon.pid.lock', 'transport.sock', 'transport.socket', 'state.sqlite', 'state.sqlite-wal', 'state.db-shm',
      'src/.visualizer-build-interrupted/app.mjs', '.tmp/private.yaml', 'pi-html/private/report.html', 'docs/pi-html/snapshot/session.jsonl', 'custom-data/pi-html/private/report.html']
    const retained = ['.env.example', '.env.sample', '.env.template', '.circleci/config.yml', 'package-lock.json',
      'src/pi-export-guard.mjs', 'src/visualizer/pi-export-guard.js', 'src/plugin-client.mjs', 'src/visualizer/assets.json', 'src/visualizer/app.mjs', 'src/visualizer/plugin.html',
      'src/visualizer/mermaid/chunks/mermaid.esm.min/chunk-example.mjs', 'src/visualizer/licenses/mermaid/LICENSE',
      'docs/images/openrig-dashboard.png', 'specs/rig.yaml', 'examples/public/rig.yaml', '.cocoindex_code/settings.yml']
    const result = await exec('git', ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', ...ignored, ...retained], { cwd: directory })
    assert.deepEqual(result.stdout.trim().split('\n').sort(), ignored.sort())
  } finally { await rm(directory, { recursive: true, force: true }) }
})
