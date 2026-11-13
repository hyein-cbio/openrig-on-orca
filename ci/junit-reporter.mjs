import path from 'node:path'

// CircleCI requires testcase inside testsuite, not directly inside testsuites.
// Publish only relative source identities, ordinals and timings: no test payloads or logs.
export default async function* junitReporter(events) {
  const ordinals = new Map()
  const cases = []
  for await (const { type, data } of events) {
    if (type !== 'test:pass' && type !== 'test:fail') continue
    const details = data.details || {}
    if (details.error?.failureType === 'subtestsFailed') continue
    if (details.type === 'suite' && type === 'test:pass' && !data.skip && !data.todo) continue
    const file = path.relative(process.cwd(), data.file || '').replaceAll('\\', '/')
    if (!/^test\/[a-zA-Z0-9_-]+\.test\.mjs$/.test(file)) throw new Error('JUnit event has an unexpected test source file')
    const ordinal = (ordinals.get(file) || 0) + 1
    ordinals.set(file, ordinal)
    const duration = details.duration_ms
    cases.push({ file, ordinal, seconds: Number.isFinite(duration) && duration >= 0 ? duration / 1000 : 0,
      skipped: Boolean(data.skip || data.todo), failed: type === 'test:fail' && !data.skip && !data.todo })
  }
  if (!cases.length) throw new Error('JUnit reporting received no test cases')
  const failed = cases.filter(c => c.failed).length
  const skipped = cases.filter(c => c.skipped).length
  const seconds = cases.reduce((sum, c) => sum + c.seconds, 0).toFixed(9)
  yield `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${cases.length}" failures="${failed}" skipped="${skipped}" time="${seconds}">\n`
  yield `<testsuite name="node tests" tests="${cases.length}" failures="${failed}" skipped="${skipped}" time="${seconds}">\n`
  for (const c of cases) {
    yield `<testcase name="test-${c.ordinal}" classname="${c.file}" file="${c.file}" time="${c.seconds.toFixed(9)}">`
    if (c.failed) yield '<failure message="Node test failed; see core-tests.log"/>'
    else if (c.skipped) yield '<skipped/>'
    yield '</testcase>\n'
  }
  yield '</testsuite>\n</testsuites>\n'
}
