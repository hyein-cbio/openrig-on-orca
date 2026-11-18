import { fail } from './runtime.mjs'
import { readPiLiveTail, type PiLiveCursor } from './pi-live-tail'
import type { PiLiveBatch } from './protocol'

const LEASE_MS = 45_000
const MAX_VIEWERS = 8
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)
const closed = () => fail('pi_live_closed', 'Live Pi stopped. Open it again to verify the selected seat.')
type Identity = Parameters<typeof readPiLiveTail>[0]
interface BoundSource { identity: Identity; verify: (signal: AbortSignal) => Promise<void>; assertCurrent?: () => void }
interface Slot { id: string; cancel: AbortController; source?: BoundSource; cursor: PiLiveCursor | null; expires: number; busy: boolean }

// The bridge never gets a path or an offset. A caller may hold only its own
// short-lived session and cannot read a different panel's transcript.
export class PiLiveSessions {
  private readonly sessions = new Map<string, Slot>()
  constructor(private readonly now = Date.now) {}

  private drop(panel: string, slot: Slot) {
    slot.cancel.abort()
    if (this.sessions.get(panel) === slot) this.sessions.delete(panel)
  }
  private prune() {
    // Expiry is an idle timeout; an admitted read is bounded by its request signal.
    for (const [panel, slot] of this.sessions) if (!slot.busy && slot.expires <= this.now()) this.drop(panel, slot)
  }
  async start(panel: string, id: unknown, signal: AbortSignal, authorize: (signal: AbortSignal) => Promise<BoundSource>): Promise<PiLiveBatch> {
    if (signal.aborted || !validId(id)) throw closed()
    this.prune()
    const existing = this.sessions.get(panel)
    if (existing) this.drop(panel, existing)
    if (this.sessions.size >= MAX_VIEWERS) throw fail('pi_live_busy', 'Close another Live Pi view before opening a new one.')
    const slot: Slot = { id, cancel: new AbortController(), cursor: null, expires: this.now() + LEASE_MS, busy: true }
    this.sessions.set(panel, slot)
    try {
      const active = AbortSignal.any([slot.cancel.signal, signal])
      active.throwIfAborted()
      slot.source = await authorize(active)
      return await this.batch(slot, active, true)
    } catch {
      this.drop(panel, slot); throw closed()
    } finally { slot.busy = false }
  }
  async read(panel: string, id: unknown, signal: AbortSignal): Promise<PiLiveBatch> {
    if (signal.aborted) throw closed()
    this.prune()
    const slot = this.sessions.get(panel)
    if (!validId(id) || !slot || slot.id !== id || !slot.source) throw closed()
    if (slot.busy) throw fail('pi_live_busy', 'A Live Pi read is already in progress.')
    slot.busy = true
    try { return await this.batch(slot, AbortSignal.any([slot.cancel.signal, signal]), false) }
    catch { this.drop(panel, slot); throw closed() }
    finally { slot.busy = false }
  }
  stop(panel: string, id: unknown) {
    const slot = this.sessions.get(panel)
    if (!validId(id) || !slot || slot.id !== id) return { stopped: false }
    this.drop(panel, slot); return { stopped: true }
  }
  private async batch(slot: Slot, signal: AbortSignal, starting: boolean): Promise<PiLiveBatch> {
    const source = slot.source!
    signal.throwIfAborted()
    if (!starting) await source.verify(signal)
    const { cursor, ...result } = await readPiLiveTail(source.identity, slot.cursor, signal)
    // Silent polls don't publish content; reverify before releasing any newly
    // projected rows so an occupant move during the read cannot cross the bridge.
    if (starting || result.events.length || result.skippedRecords) await source.verify(signal)
    signal.throwIfAborted()
    source.assertCurrent?.() // A routing write may start while the final async verification is completing.
    slot.cursor = cursor; slot.expires = this.now() + LEASE_MS
    return { id: slot.id, ...result }
  }
}
