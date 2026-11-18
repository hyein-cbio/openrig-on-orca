import { constants } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { PiLiveEvent } from './protocol'

const INITIAL_BYTES = 128 * 1024
const READ_BYTES = 256 * 1024
const CHECKPOINT_BYTES = INITIAL_BYTES // Reverify the retained recent byte window, not the complete conversation.
const MAX_ROWS = 24
// Limit actual JSON (not raw UTF-8 payload) so escaping control characters cannot inflate bridge responses.
const MAX_EVENT_BYTES = 64 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })

export interface PiLiveCursor { offset: number; skipping: boolean; anchor: string; size: number; mtime: number; ctime: number }
type FileIdentity = { file: string; dev: string; ino: string }
const changed = () => new Error('The Pi history changed while following it. Open Live Pi again to verify the seat.')
const bounded = (value: unknown, limit: number) => typeof value === 'string' ? value.length <= limit ? value : value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '') + '\n… excerpt' : ''
const object = (value: unknown): { [name: string]: unknown } | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as { [name: string]: unknown } : undefined
const blocks = (value: unknown) => Array.isArray(value) ? value.map(object) : []
const toolKey = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : ''
function content(value: unknown) {
  if (typeof value === 'string') return bounded(value, 4000)
  let text = ''
  for (const block of blocks(value)) {
    const chunk = block?.type === 'text' ? block.text : block?.type === 'image' ? '[Image omitted]' : ''
    if (typeof chunk !== 'string' || !chunk) continue
    text += (text ? '\n' : '') + bounded(chunk, 4001)
    if (text.length > 4000) break
  }
  return bounded(text, 4000)
}
function toolHint(args: unknown) {
  const a = object(args)
  if (!a) return ''
  for (const key of ['command', 'path', 'file_path', 'query', 'pattern']) {
    if (typeof a[key] === 'string' && a[key]) return bounded(a[key].split('\n', 1)[0], 240)
  }
  return ''
}

// A minimal on-disk projection: no system prompts, arbitrary extension details, image bytes,
// or executable tool renderers. The UI only receives the fields it can display.
export function projectPiRecord(value: unknown, offset: number): PiLiveEvent[] {
  const entry = object(value)
  if (!entry || typeof entry.type !== 'string') throw new Error('Invalid Pi record')
  const time = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  const output: PiLiveEvent[] = []
  const add = (kind: PiLiveEvent['kind'], title: string, text: string, extra: Pick<PiLiveEvent, 'toolId' | 'error'> = {}) => {
    if (output.length < 6) output.push({ key: `${offset}:${output.length}`, kind, title, text, ...(Number.isFinite(time) ? { time } : {}), ...extra })
  }
  if (entry.type === 'compaction') add('marker', 'Context compacted', '')
  if (entry.type === 'branch_summary') add('marker', 'Branch summary recorded', '')
  const msg = entry.type === 'message' && object(entry.message)
  if (!msg) return output
  switch (msg.role) {
    case 'user': {
      const text = content(msg.content)
      if (text) add('user', 'You', text)
      break
    }
    case 'assistant': {
      const message = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : blocks(msg.content)
      const stopped = msg.stopReason === 'error' || msg.stopReason === 'aborted'
      const capacity = stopped ? 5 : 6
      for (const block of message) {
        const row: Parameters<typeof add> | null = block?.type === 'text' && typeof block.text === 'string' && block.text.trim()
          ? ['assistant', bounded(msg.model, 120) || 'Pi', bounded(block.text, 4000)]
          : block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()
            ? ['thinking', 'Thinking', bounded(block.thinking, 4000)]
            : block?.type === 'toolCall' ? ['tool', bounded(block.name, 100) || 'Tool', toolHint(block.arguments), { toolId: toolKey(block.id) }] : null
        if (!row) continue
        if (output.length >= capacity) { output.pop(); add('marker', 'More blocks omitted from this message', ''); break }
        add(...row)
      }
      if (stopped) add('error', msg.stopReason === 'aborted' ? 'Response interrupted' : 'Response failed', bounded(msg.errorMessage, 2000))
      break
    }
    case 'toolResult': {
      add('result', bounded(msg.toolName, 100) || 'Tool result', content(msg.content), { toolId: toolKey(msg.toolCallId), error: msg.isError === true })
      break
    }
    case 'bashExecution':
      add('shell', bounded(msg.command, 240) || 'Shell command', bounded(msg.output, 4000), { error: msg.cancelled === true || typeof msg.exitCode === 'number' && msg.exitCode !== 0 })
      break
  }
  return output
}

async function range(fd: FileHandle, zero: number, length: number, signal: AbortSignal) {
  const bytes = Buffer.alloc(length)
  for (let i = 0; i < length;) {
    signal.throwIfAborted()
    const { bytesRead } = await fd.read(bytes, i, length - i, zero + i)
    if (!bytesRead) throw changed()
    i += bytesRead
  }
  return bytes
}
const checkpoint = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** Read a fixed, bounded range of one already-authorized file, never a directory. */
export async function readPiLiveTail(identity: FileIdentity, cursor: PiLiveCursor | null, signal: AbortSignal) {
  signal.throwIfAborted()
  const fd = await open(identity.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await fd.stat()
    const matches = (info: typeof before) => info.isFile() && String(info.dev) === identity.dev && String(info.ino) === identity.ino
    if (!matches(before) || !before.size || !Number.isSafeInteger(before.size)) throw changed()
    if (cursor && (before.size < cursor.size || before.size === cursor.size && (before.mtimeMs !== cursor.mtime || before.ctimeMs !== cursor.ctime))) throw changed()
    const start = cursor?.offset ?? Math.max(0, before.size - INITIAL_BYTES)
    const omittedHistory = !cursor && start > 0
    const prefixStart = Math.max(0, start - CHECKPOINT_BYTES), prefixLength = start - prefixStart
    const snapshot = await range(fd, prefixStart, prefixLength + Math.min(READ_BYTES, before.size - start), signal)
    const prefix = snapshot.subarray(0, prefixLength), input = snapshot.subarray(prefixLength)
    if (cursor && checkpoint(prefix) !== cursor.anchor) throw changed()
    let skipping = cursor?.skipping ?? (start > 0 && prefix.at(-1) !== 10)
    let consumed = 0, skippedRecords = 0, responseBytes = 0, more = false
    const events: PiLiveEvent[] = []
    while (consumed < input.length) {
      const end = input.indexOf(10, consumed)
      if (end < 0) {
        // Incomplete, ordinary append: don't commit its bytes. For an oversized
        // record keep discarding bounded chunks until its eventual newline.
        if (skipping || input.length - consumed === READ_BYTES) {
          if (!skipping) skippedRecords++
          skipping = true; consumed = input.length; more = start + consumed < before.size
        } else more = start + input.length < before.size
        break
      }
      if (skipping) { skipping = false; consumed = end + 1; continue }
      if (end === consumed) { consumed++; continue }
      let next: PiLiveEvent[]
      try { next = projectPiRecord(JSON.parse(decoder.decode(input.subarray(consumed, end))), start + consumed) }
      catch { skippedRecords++; consumed = end + 1; continue }
      const bytes = Buffer.byteLength(JSON.stringify(next))
      if (next.length && (events.length + next.length > MAX_ROWS || responseBytes + bytes > MAX_EVENT_BYTES)) {
        if (events.length) { more = true; break }
        skippedRecords++; consumed = end + 1; continue
      }
      if (next.length) { events.push(...next); responseBytes += bytes }
      consumed = end + 1
    }
    if (start + input.length < before.size) more = true
    const offset = start + consumed
    // Commit a checkpoint from the same validated snapshot used to project the batch.
    if (!snapshot.equals(await range(fd, prefixStart, snapshot.length, signal))) throw changed()
    const committed = prefixLength + consumed
    const anchor = checkpoint(snapshot.subarray(Math.max(0, committed - CHECKPOINT_BYTES), committed))
    const after = await stat(identity.file)
    if (!matches(after) || after.size < before.size || after.size === before.size && (after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)) throw changed()
    signal.throwIfAborted()
    // Keep the size from before the read so a concurrent append is eligible next time.
    return { cursor: { offset, skipping, anchor, size: before.size, mtime: before.mtimeMs, ctime: before.ctimeMs }, events, omittedHistory, skippedRecords, more }
  } finally { await fd.close() }
}
