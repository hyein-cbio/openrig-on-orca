export const REFRESH_MS = 60000
export const MAX_REFRESH_MS = 8 * REFRESH_MS

// One cancellable read at a time. No worker/action names, writes or catch-up bursts live in this loop.
export function createRefreshLoop({ run, context, blocked, lastSuccess, changed = () => {}, clock = {} }) {
  const now = clock.now || Date.now, set = clock.setTimeout || setTimeout, clear = clock.clearTimeout || clearTimeout
  const state = { enabled: false, visible: false, visibilityKnown: false, inFlight: false, failures: 0, nextAt: null, lastAttemptAt: 0, lastSuccessAt: 0, paused: 'Off' }
  let timer = null, controller = null, scope = '', due = 0, epoch = 0, disposed = false
  const stopTimer = () => { if (timer !== null) clear(timer); timer = null }
  function abort() { if (controller && !controller.signal.aborted) { epoch++; controller.abort() } }
  function sync() {
    if (disposed) return
    const nextScope = context() || ''
    if (nextScope !== scope) { abort(); scope = nextScope; state.failures = 0; state.lastSuccessAt = lastSuccess() || 0; due = scope ? (state.lastSuccessAt || now()) + REFRESH_MS : 0 }
    const reason = !state.enabled ? 'Off' : !state.visibilityKnown ? 'Visibility unverified' : !state.visible ? 'Panel hidden' : !scope ? 'Choose a native pod' : blocked()
    state.paused = reason || ''
    if (reason) { stopTimer(); state.nextAt = null; abort(); return }
    if (controller) { stopTimer(); state.nextAt = null; return }
    if (!due) due = (lastSuccess() || now()) + REFRESH_MS
    stopTimer(); state.nextAt = due
    timer = set(tick, Math.max(0, due - now())); timer?.unref?.()
  }
  async function tick() {
    timer = null
    sync()
    if (state.paused || controller || disposed) return
    stopTimer()
    controller = new AbortController(); const active = controller, revision = ++epoch
    state.inFlight = true; state.nextAt = null; state.lastAttemptAt = now(); changed(state)
    let ok = false
    try { ok = await run(active.signal) === true } catch { /* Failed observations retain their last-good data. */ }
    finally {
      controller = null; state.inFlight = false
      if (!disposed && revision === epoch && !active.signal.aborted) {
        if (ok) { state.failures = 0; state.lastSuccessAt = now() }
        else state.failures = Math.min(state.failures + 1, 3)
        due = now() + Math.min(MAX_REFRESH_MS, REFRESH_MS * 2 ** state.failures)
      }
      if (!disposed) { sync(); changed(state) }
    }
  }
  return {
    state, sync,
    setEnabled(value) { state.enabled = value === true; sync(); changed(state) },
    setVisibility(visible, known = true) { state.visible = visible === true; state.visibilityKnown = known === true; sync(); changed(state) },
    success(at = now()) { state.failures = 0; state.lastSuccessAt = at; due = at + REFRESH_MS; sync() },
    failure() { state.failures = Math.min(state.failures + 1, 3); due = now() + Math.min(MAX_REFRESH_MS, REFRESH_MS * 2 ** state.failures); sync() },
    cancel() { abort() },
    dispose() { disposed = true; stopTimer(); abort(); state.nextAt = null; state.paused = 'Disposed' }
  }
}

// HTML frames expose no documented Orca visibility event. Combine standard document lifecycle
// with intersection (including iframe clipping); unknown visibility conservatively suspends polling.
export function watchPanelVisibility({ document, window, IntersectionObserver, changed }) {
  let intersecting = null, suspended = false
  const tracksVisibility = Boolean(window.IntersectionObserverEntry && 'isVisible' in window.IntersectionObserverEntry.prototype)
  const update = () => { const hidden = suspended || document.visibilityState !== 'visible'; changed(!hidden && intersecting === true, hidden || intersecting !== null) }
  const hide = () => { suspended = true; update() }, show = () => { suspended = false; update() }
  const observer = IntersectionObserver ? new IntersectionObserver(entries => {
    const entry = entries.find(e => e.target === document.documentElement)
    if (entry) { intersecting = !entry.isIntersecting || entry.intersectionRatio <= 0 ? false : tracksVisibility ? entry.isVisible === true : null; update() }
  }, tracksVisibility ? { trackVisibility: true, delay: 100 } : undefined) : null
  observer?.observe(document.documentElement)
  document.addEventListener('visibilitychange', update); window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show)
  update()
  return { dispose() { suspended = true; observer?.disconnect(); document.removeEventListener('visibilitychange', update); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); update() } }
}
