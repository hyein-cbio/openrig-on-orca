import { mountTranscript } from '../vendor/pi-esp/view.js'
import type { TranscriptEvent } from '../vendor/pi-esp/records.js'
import type { PiLiveBatch, PiLiveEvent } from './protocol'

function transcriptEvent(event: PiLiveEvent): TranscriptEvent {
  const date = typeof event.time === 'number' ? new Date(event.time) : null
  const row = { key: event.key, ...(date && Number.isFinite(date.getTime()) ? { at: date.toISOString() } : {}) }
  switch (event.kind) {
    case 'tool': return { ...row, kind: 'tool-call', callId: event.toolId, name: event.title, target: event.text }
    case 'result': return { ...row, kind: 'tool-result', callId: event.toolId, name: event.title, output: event.text, failed: event.error === true }
    case 'shell': return { ...row, kind: 'shell', command: event.title, output: event.text, failed: event.error === true }
    case 'marker': return { ...row, kind: 'notice', text: event.title }
    case 'error': return { ...row, kind: 'error', text: event.text ? `${event.title}: ${event.text}` : event.title }
    default: return { ...row, kind: event.kind, text: event.text }
  }
}

/** Bind Native projections to the embedded read-only renderer; the controller still owns the selection and polling. */
export function createPiLiveView(root: HTMLElement) {
  const at = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!
  const log = at('pi-live-log'), title = at('pi-live-heading'), target = at('pi-live-target'), status = at('pi-live-status')
  const restart = at<HTMLButtonElement>('pi-live-resume'), close = at<HTMLButtonElement>('pi-live-close'), note = at('pi-live-note'), empty = at('pi-live-empty')
  const transcript = mountTranscript(log), feed = log.querySelector('.pi-esp-feed')
  let skipped = 0, omitted = false, resetHeldFocus = false
  function reset(label: string | null) {
    resetHeldFocus = label !== null && root.contains(root.ownerDocument.activeElement)
    root.hidden = label === null; target.textContent = label ?? ''
    transcript.clear(); skipped = 0; omitted = false
    log.hidden = note.hidden = true; empty.hidden = false; note.textContent = ''
  }
  return {
    focus() { title.focus(); root.scrollIntoView({ block: 'nearest' }) },
    reset,
    hide: () => reset(null),
    dispose: () => transcript.dispose(),
    status(message: string, canRestart = false) {
      if (status.textContent !== message) status.textContent = message
      restart.hidden = !canRestart; empty.hidden = !log.hidden || canRestart
      if (resetHeldFocus) (canRestart ? restart : close).focus({ preventScroll: true })
      resetHeldFocus = false
    },
    append(batch: PiLiveBatch) {
      if (batch.events.length) {
        const oldest = feed?.firstElementChild
        // Unhide before append so the renderer measures the real scroll viewport.
        log.hidden = false; empty.hidden = true
        transcript.append(batch.events.map(transcriptEvent))
        if (oldest && !feed?.contains(oldest)) omitted = true
      }
      omitted ||= batch.omittedHistory; skipped += batch.skippedRecords
      note.textContent = [omitted ? 'Older history not shown. Use the HTML snapshot for a fixed transcript.' : '', skipped ? `${skipped} oversized or invalid ${skipped === 1 ? 'record' : 'records'} skipped.` : ''].filter(Boolean).join(' ')
      note.hidden = !note.textContent
    }
  }
}
