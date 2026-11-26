import type { PiLiveBatch, PiLiveScope } from './protocol'

const POLL_MS = 2000
const CATCHUP_MS = 200
const WAIT_MS = 5000
interface Request { (name: string, input: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown> }
interface View {
  reset(label: string): void
  append(batch: PiLiveBatch): void
  status(message: string, restart?: boolean): void
  hide(): void
}
interface Follow { scope: PiLiveScope; label: string; id: string; cancel: AbortController; waiting?: boolean; timer?: ReturnType<typeof setTimeout> }
const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')

/** Follow one selection. Scope changes and visibility loss discard both rows and late replies. */
export function createPiLiveController(request: Request | null, view: View, eligible: (scope: PiLiveScope) => boolean, visible: () => boolean, makeId = id) {
  let follow: Follow | undefined, selection: { scope: PiLiveScope; label: string } | undefined
  const end = () => {
    const old = follow; follow = undefined
    if (!old) return
    clearTimeout(old.timer); old.cancel.abort()
    void request?.('pi-live.stop', { id: old.id }, { timeoutMs: 3000 }).catch(() => {})
  }
  const close = () => { end(); selection = undefined; view.hide() }
  function sync() {
    if (!selection) return
    if (!eligible(selection.scope)) { close(); return }
    if (follow && !visible()) {
      end(); view.reset(selection.label); view.status('Paused while hidden. Resume to verify the same seat again.', true)
    }
  }
  async function poll(current: Follow, starting: boolean) {
    sync()
    if (!request || follow !== current) return
    try {
      const batch = await request(starting ? 'pi-live.start' : 'pi-live.read', { ...(starting ? current.scope : {}), id: current.id }, { signal: current.cancel.signal, timeoutMs: starting ? 60000 : 55000 }) as PiLiveBatch
      sync()
      if (follow !== current) return
      if (batch?.id !== current.id || !Array.isArray(batch.events) || batch.events.length > 24) throw new Error('Unexpected Live Pi response')
      if (batch.waiting) {
        if (!current.waiting) view.reset(current.label)
        current.waiting = true
        view.status('Waiting for verified Pi history for this seat…')
      } else {
        current.waiting = false
        if (batch.reset) view.reset(current.label)
        if (batch.events.length || batch.skippedRecords || batch.omittedHistory) view.append(batch)
        view.status(batch.more ? 'Loading recent records…' : 'Following recorded messages · read only')
      }
      current.timer = setTimeout(() => { void poll(current, false) }, batch.waiting ? WAIT_MS : batch.more ? CATCHUP_MS : POLL_MS)
    } catch (error) {
      sync()
      if (follow === current) {
        end(); view.reset(current.label)
        const busy = error && typeof error === 'object' && 'code' in error && error.code === 'pi_live_busy'
        view.status(busy ? 'Close another Live Pi view before opening a new one.' : 'The selected Pi history could not be verified. No other session was opened.', true)
      }
    }
  }
  function open(scope: PiLiveScope, label: string) {
    if (!request || !eligible(scope) || !visible()) return false
    end(); selection = { scope, label }
    const current = { ...selection, id: makeId(), cancel: new AbortController() }
    follow = current; view.reset(label); view.status('Verifying the selected Pi seat…')
    void poll(current, true); return true
  }
  return { open, close, sync, resume: () => selection ? open(selection.scope, selection.label) : false }
}
