import test from 'node:test'
import assert from 'node:assert/strict'
import { createRefreshLoop, REFRESH_MS, watchPanelVisibility } from '../src/refresh-loop.mjs'
import { testClock } from './refresh-clock.mjs'

test('refresh is opt-in, exactly one minute when healthy and exponential 2/4/8 minutes on failures', async () => {
  const clock = testClock(); let calls = 0, succeeds = true
  const loop = createRefreshLoop({ clock, run: async () => { calls++; return succeeds }, context: () => 'fixture', blocked: () => '', lastSuccess: () => 1000000 })
  loop.setVisibility(true); await clock.advance(2 * REFRESH_MS); assert.equal(calls, 0)
  loop.setEnabled(true); await clock.advance(0); assert.equal(calls, 1)
  await clock.advance(REFRESH_MS - 1); assert.equal(calls, 1); await clock.advance(1); assert.equal(calls, 2)
  succeeds = false; await clock.advance(REFRESH_MS); assert.equal(calls, 3); assert.equal(loop.state.failures, 1)
  await clock.advance(2 * REFRESH_MS); assert.equal(calls, 4); assert.equal(loop.state.failures, 2)
  await clock.advance(4 * REFRESH_MS); assert.equal(calls, 5); assert.equal(loop.state.failures, 3)
  await clock.advance(8 * REFRESH_MS); assert.equal(calls, 6); assert.equal(loop.state.nextAt - clock.now(), 8 * REFRESH_MS)
  succeeds = true; await clock.advance(8 * REFRESH_MS); assert.equal(loop.state.failures, 0); assert.equal(loop.state.nextAt - clock.now(), REFRESH_MS)
  loop.dispose(); assert.equal(clock.pending(), 0)
})
test('hidden/unknown visibility and review/edit/work gates suspend reads; resume makes one overdue read only', async () => {
  const clock = testClock(); let calls = 0, reason = ''
  const loop = createRefreshLoop({ clock, run: async () => { calls++; return true }, context: () => 'fixture', blocked: () => reason, lastSuccess: () => 1000000 })
  loop.setEnabled(true); await clock.advance(5 * REFRESH_MS); assert.equal(calls, 0)
  loop.setVisibility(true); await clock.advance(0); assert.equal(calls, 1)
  for (const block of ['Operation review open', 'Unsaved configuration', 'Another operation or read is running', 'YAML preview']) {
    reason = block; loop.sync(); await clock.advance(3 * REFRESH_MS); assert.equal(calls, 1)
  }
  reason = ''; loop.sync(); await clock.advance(0); assert.equal(calls, 2)
  loop.setVisibility(false); await clock.advance(5 * REFRESH_MS); assert.equal(calls, 2)
  loop.setVisibility(true); await clock.advance(0); assert.equal(calls, 3); assert.equal(loop.state.nextAt - clock.now(), REFRESH_MS)
  loop.setEnabled(false); await clock.advance(100 * REFRESH_MS); assert.equal(calls, 3); loop.dispose()
})
test('an in-flight read never overlaps and hiding aborts without counting cancellation as a failure', async () => {
  const clock = testClock(); let calls = 0, finish, signal
  const loop = createRefreshLoop({ clock, run: s => { calls++; signal = s; return new Promise(resolve => { finish = resolve }) }, context: () => 'fixture', blocked: () => '', lastSuccess: () => 1000000 })
  loop.setVisibility(true); loop.setEnabled(true); await clock.advance(REFRESH_MS); assert.equal(calls, 1); assert.equal(loop.state.inFlight, true)
  await clock.advance(5 * REFRESH_MS); assert.equal(calls, 1)
  loop.setVisibility(false); assert.equal(signal.aborted, true); finish(true); await clock.flush(); assert.equal(loop.state.failures, 0); assert.equal(loop.state.inFlight, false)
  loop.setVisibility(true); await clock.advance(0); assert.equal(calls, 2); loop.dispose(); assert.equal(signal.aborted, true); finish(false); await clock.flush(); assert.equal(clock.pending(), 0)
})
test('HTML visibility uses document lifecycle AND intersection, with no invented Orca event or visible fallback', () => {
  const document = new EventTarget(), window = new EventTarget(); document.visibilityState = 'visible'; document.documentElement = {}
  let listener, disconnected = false; const values = []
  window.IntersectionObserverEntry = class {}; window.IntersectionObserverEntry.prototype.isVisible = false
  class Observer { constructor(callback) { listener = callback } observe() {} disconnect() { disconnected = true } }
  const gate = watchPanelVisibility({ document, window, IntersectionObserver: Observer, changed: (visible, known) => values.push([visible, known]) })
  assert.deepEqual(values.at(-1), [false, false])
  listener([{ target: document.documentElement, isIntersecting: true, intersectionRatio: .5, isVisible: true }]); assert.deepEqual(values.at(-1), [true, true])
  listener([{ target: document.documentElement, isIntersecting: false, intersectionRatio: 0 }]); assert.deepEqual(values.at(-1), [false, true])
  listener([{ target: document.documentElement, isIntersecting: true, intersectionRatio: .5, isVisible: true }]); document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); assert.deepEqual(values.at(-1), [false, true])
  document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); assert.deepEqual(values.at(-1), [true, true])
  window.dispatchEvent(new Event('pagehide')); assert.deepEqual(values.at(-1), [false, true]); window.dispatchEvent(new Event('pageshow')); assert.deepEqual(values.at(-1), [true, true])
  gate.dispose(); assert.equal(disconnected, true); assert.deepEqual(values.at(-1), [false, true])
  const unknown = watchPanelVisibility({ document, window, changed: (visible, known) => values.push([visible, known]) }); assert.deepEqual(values.at(-1), [false, false]); unknown.dispose()
})
