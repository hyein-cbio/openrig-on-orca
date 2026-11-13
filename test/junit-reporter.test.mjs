import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import reporter from '../ci/junit-reporter.mjs'
const exec = promisify(execFile)
const file = path.resolve('test/fixture.test.mjs')
const event = (type, extra = {}) => ({ type, data: { file, details: { type: 'test', duration_ms: 1 }, ...extra } })
async function render(events) {
  let xml = ''
  for await (const chunk of reporter(events)) xml += chunk
  return xml
}
function assertNested(xml) {
  const root = xml.match(/^<\?xml[^>]*>\s*<testsuites\b[^>]*>([\s\S]*)<\/testsuites>\s*$/)
  assert.ok(root, 'Expected a complete testsuites root')
  assert.match(root[1], /<testsuite\b/)
  assert.equal(root[1].replace(/<testsuite\b[^>]*>[\s\S]*?<\/testsuite>/g, '').trim(), '', 'Only testsuite may appear directly inside testsuites')
}

test('JUnit uses the CircleCI hierarchy and excludes payloads, diagnostics and absolute paths', async () => {
  const marker = 'private-fixture-' + 'do-not-upload'
  const xml = await render([
    { type: 'test:stdout', data: { message: marker } },
    event('test:pass', { name: marker }),
    event('test:fail', { name: marker, details: { type: 'test', duration_ms: 2, error: new Error(marker) } })
  ])
  assertNested(xml)
  assert.match(xml, /tests="2" failures="1"/)
  assert.match(xml, /file="test\/fixture.test.mjs"/)
  assert.doesNotMatch(xml, new RegExp(marker))
  assert.equal(xml.includes(process.cwd()), false)
  assert.match(xml, /name="test-1"/); assert.match(xml, /name="test-2"/)
})
test('skip, todo and hook failures are reported without duplicate composite failures', async () => {
  const xml = await render([
    event('test:pass'), event('test:pass', { skip: 'reason' }), event('test:fail', { todo: 'reason' }),
    event('test:fail'),
    event('test:pass', { details: { type: 'suite' } }),
    event('test:fail', { details: { type: 'suite', error: { failureType: 'hookFailed' } } }),
    event('test:fail', { details: { type: 'suite', error: { failureType: 'subtestsFailed' } } })
  ])
  assertNested(xml)
  assert.match(xml, /tests="5" failures="2" skipped="2"/)
  assert.equal((xml.match(/<failure /g) || []).length, 2)
  assert.equal((xml.match(/<skipped\/>/g) || []).length, 2)
})
test('missing cases and unexpected file identities fail closed', async () => {
  await assert.rejects(render([]), /no test cases/)
  for (const source of [undefined, path.resolve('../private.test.mjs'), path.resolve('test/unsafe&.test.mjs')]) {
    await assert.rejects(render([event('test:pass', { file: source })]), /unexpected test source file/)
  }
})
test('durations are finite decimal seconds and ordinals are scoped to the file', async () => {
  const xml = await render([
    event('test:pass', { details: { duration_ms: Infinity } }),
    event('test:pass', { details: { duration_ms: -1 } }),
    event('test:pass', { file: path.resolve('test/second.test.mjs'), details: { duration_ms: 0.0001 } })
  ])
  assertNested(xml)
  assert.equal((xml.match(/name="test-1"/g) || []).length, 2)
  assert.doesNotMatch(xml, /NaN|Infinity|time="[^"]*e-/)
  assert.match(xml, /time="0\.000000100"/)
})
test('the real Node test runner emits compatible XML and retains a failed-test exit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-junit-test-'))
  try {
    await mkdir(path.join(root, 'test'))
    const source = `import test from 'node:test';import assert from 'node:assert/strict';test('pass',()=>{});test.skip('skip',()=>{});test.todo('todo',()=>{});test('fail',()=>{console.log('private-payload');assert.fail('private-payload')});`
    await writeFile(path.join(root, 'test', 'fixture.test.mjs'), source)
    const output = path.join(root, 'report.xml')
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT // The subprocess is a standalone runner, not a child of this test harness.
    let exit = 0
    try {
      await exec(process.execPath, ['--test', `--test-reporter=${fileURLToPath(new URL('../ci/junit-reporter.mjs', import.meta.url))}`, `--test-reporter-destination=${output}`, 'test/fixture.test.mjs'], { cwd: root, env, timeout: 15000 })
    } catch (error) { exit = error.code }
    assert.equal(exit, 1)
    const xml = await readFile(output, 'utf8')
    assertNested(xml)
    assert.match(xml, /tests="4" failures="1" skipped="2"/)
    assert.doesNotMatch(xml, /private-payload/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('a real skipped suite is retained as a skipped result even when its body never executes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-junit-skip-test-'))
  try {
    await mkdir(path.join(root, 'test'))
    await writeFile(path.join(root, 'test', 'fixture.test.mjs'), "import {describe} from 'node:test';describe.skip('optional',()=>{throw new Error('must not run')});")
    const output = path.join(root, 'report.xml')
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
    await exec(process.execPath, ['--test', `--test-reporter=${fileURLToPath(new URL('../ci/junit-reporter.mjs', import.meta.url))}`, `--test-reporter-destination=${output}`, 'test/fixture.test.mjs'], { cwd: root, env, timeout: 15000 })
    const xml = await readFile(output, 'utf8')
    assertNested(xml)
    assert.match(xml, /tests="1" failures="0" skipped="1"/)
    assert.match(xml, /<skipped\/>/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('CI selects the compatible reporter and preserves XML as downloadable evidence', async () => {
  const worker = await readFile(new URL('../ci/run-ci.mjs', import.meta.url), 'utf8')
  const config = await readFile(new URL('../.circleci/config.yml', import.meta.url), 'utf8')
  assert.match(worker, /--test-reporter=\.\/ci\/junit-reporter\.mjs/)
  assert.doesNotMatch(worker, /--test-reporter=junit/)
  assert.match(config, /destination: core-junit-/)
  assert.match(config, /destination: orca-junit/)
})
