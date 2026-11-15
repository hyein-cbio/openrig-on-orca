import test from 'node:test'
import assert from 'node:assert/strict'
import { topologyClientFixture } from './topology-client-fixture.mjs'

for (const [event, key] of [['click'], ['keydown', 'Enter'], ['keydown', ' ']]) {
  test(`a removed hub's old ${key ? `${event}/${JSON.stringify(key)}` : event} cannot cancel an in-flight membership refresh`, async () => {
    const f = await topologyClientFixture()
    f.observe(); await f.flush()
    const oldSvg = f.svg, oldHub = f.nodes.find(node => node.getAttribute('aria-label').startsWith('View downstream structure of hub hub;'))
    assert.ok(oldHub)
    const paused = f.pauseNextRender()
    f.observe({ members: f.seats.filter(seat => seat.logicalId !== 'hub') })
    await paused.started
    assert.equal(f.svg, oldSvg, 'The prior SVG remains visible while the refreshed diagram renders')
    const selected = f.element('agent-name').textContent
    try {
      assert.doesNotThrow(() => oldHub.fire(event, key), 'Stale activation must not project a missing hub or mutate navigation')
      assert.equal(f.element('agent-name').textContent, selected, 'Stale node details must not be selected either')
    } finally { paused.release(); await f.flush() }
    assert.notEqual(f.svg, oldSvg, 'The valid refresh render must still commit')
    assert.equal(f.nodes.length, 8); assert.equal(f.element('topology-path').textContent, 'Main')
    assert.equal(f.element('topology-main').hidden, true); assert.equal(f.element('error').hidden, true)
    assert.equal(f.element('export').disabled, false)
  })
}

test('old hub activation is rejected after an instance change even when the new graph contains the same seat key', async () => {
  const f = await topologyClientFixture()
  f.observe(); await f.flush()
  const oldSvg = f.svg, oldHub = f.nodes.find(node => node.getAttribute('aria-label').startsWith('View downstream structure of hub hub;'))
  const paused = f.pauseNextRender()
  f.observe({ instance: 'other-instance' }); await paused.started
  try { oldHub.fire('click') } finally { paused.release(); await f.flush() }
  assert.notEqual(f.svg, oldSvg); assert.equal(f.element('topology-path').textContent, 'Main')
  assert.equal(f.element('topology-main').hidden, true); assert.equal(f.renderCalls.length, 2)
})

test('a detached SVG cannot navigate after a newer redraw commits for the same model', async () => {
  const f = await topologyClientFixture()
  f.observe(); await f.flush()
  const oldHub = f.nodes.find(node => node.getAttribute('aria-label').startsWith('View downstream structure of hub hub;'))
  f.theme(); await f.flush()
  oldHub.fire('click'); await f.flush()
  assert.equal(f.element('topology-path').textContent, 'Main'); assert.equal(f.renderCalls.length, 2)
})

test('repeated activation from the previous view cannot restart a pending drill-down', async () => {
  const f = await topologyClientFixture()
  f.observe(); await f.flush()
  const oldHub = f.nodes.find(node => node.getAttribute('aria-label').startsWith('View downstream structure of hub hub;'))
  const paused = f.pauseNextRender()
  oldHub.fire('click'); await paused.started
  try { oldHub.fire('keydown', 'Enter') } finally { paused.release(); await f.flush() }
  assert.equal(f.element('topology-path').textContent, 'Main → hub'); assert.equal(f.renderCalls.length, 2)
})

test('the displayed hub remains navigable after a metadata-only refresh of the same model', async () => {
  const f = await topologyClientFixture()
  f.observe(); await f.flush()
  const oldSvg = f.svg, hub = f.nodes.find(node => node.getAttribute('aria-label').startsWith('View downstream structure of hub hub;'))
  f.observe({ status: 'partial' }); assert.equal(f.svg, oldSvg)
  hub.fire('click'); await f.flush()
  assert.equal(f.element('topology-path').textContent, 'Main → hub')
  assert.match(f.element('topology-view-summary').textContent, /Relationship observation: partial/)
  assert.equal(f.element('error').hidden, true)
})

for (const [initial, latest] of [['complete', 'partial'], ['partial', 'complete'], ['complete', 'unavailable']]) {
  test(`a pending theme redraw uses the latest ${initial} -> ${latest} metadata in both UI and export`, async () => {
    const f = await topologyClientFixture()
    f.observe({ status: initial }); await f.flush()
    const oldSvg = f.svg, paused = f.pauseNextRender()
    f.theme(); await paused.started
    try {
      f.observe({ status: latest, notes: ['Latest relationship observation'], stamp: 61000 })
      assert.equal(f.svg, oldSvg, 'The completeness-only refresh must use the no-redraw fast path')
      assert.match(f.element('topology-view-summary').textContent, new RegExp(`Relationship observation: ${latest}`))
      assert.match(f.svg.querySelector('desc').textContent, new RegExp(`Relationship observation: ${latest}`))
    } finally { paused.release(); await f.flush() }
    assert.notEqual(f.svg, oldSvg, 'The paused redraw must complete, not just retain the fast-path SVG')
    assert.equal(f.renderCalls.length, 2, 'Metadata-only updates should not require another layout render')
    assert.match(f.element('topology-view-summary').textContent, new RegExp(`Relationship observation: ${latest}`))
    assert.match(f.svg.querySelector('desc').textContent, new RegExp(`Relationship observation: ${latest}`))
    assert.match(f.element('warnings').textContent, /Latest relationship observation/)
    assert.match(f.element('notice').textContent, new RegExp(`Relationships: ${latest}`))
    assert.equal(f.element('edge-count').textContent, latest === 'unavailable' ? '—' : latest === 'partial' ? '1 / 8 observed' : '1 / 8')
    await Promise.all(f.element('export').fire('click'))
    assert.equal(f.exported.length, 1)
    assert.match(f.exported[0].data, new RegExp(`Relationship observation: ${latest}`))
    assert.equal(f.element('error').hidden, true)
  })
}
