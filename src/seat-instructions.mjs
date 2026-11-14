// Shared with the sandboxed panel: keep this module free of Node APIs.
export const INSTRUCTION_LIMIT = 2000

export function canInstruct(seat) {
  return Boolean(seat && seat.status === 'running' && seat.activity === 'idle' && !seat.attention &&
    ['claude-code', 'codex', 'pi'].includes(seat.runtime) && typeof seat.session === 'string' && seat.session.length <= 200 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(seat.session))
}

export function instructionTextError(text) {
  if (typeof text !== 'string' || !text.trim()) return 'Enter a nonempty instruction.'
  if (text.length > INSTRUCTION_LIMIT) return 'Use at most 2000 characters.'
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) return 'Use a single line without control characters.'
  return ''
}

export const instructionEndpoint = config => `http://127.0.0.1:${config.daemonPort}`
