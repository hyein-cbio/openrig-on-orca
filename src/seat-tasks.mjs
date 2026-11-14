// Pure GUI/worker rules. These are operator controls, not a security sandbox.
export const TASK_SUMMARY_LIMIT = 200
export const TASK_BODY_LIMIT = 4000
const identifier = value => typeof value === 'string' && value.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
export function managedAgent(seat) {
  return Boolean(seat && seat.rigNameKnown !== false && identifier(seat.rigId) && identifier(seat.logicalId) &&
    typeof seat.rigName === 'string' && seat.rigName.trim().toLowerCase() !== 'kernel' &&
    ['claude-code', 'codex', 'pi'].includes(seat.runtime))
}
export function canStartSeat(seat) {
  return managedAgent(seat) && !seat.attention && seat.lifecycle !== 'running' && seat.lifecycle !== 'attention_required' &&
    ['stopped', 'exited', 'detached', 'not-started', 'recoverable'].includes(seat.status)
}
export function canQueueTask(seat) {
  return managedAgent(seat) && seat.status === 'running' && !seat.attention && typeof seat.session === 'string' && seat.session.length <= 200 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(seat.session)
}
export function taskTextError(summary, body) {
  if (typeof summary !== 'string' || !summary.trim() || summary.length > TASK_SUMMARY_LIMIT || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(summary)) return 'Enter a single-line task title of 1–200 characters without control input.'
  if (typeof body !== 'string' || !body.trim() || body.length > TASK_BODY_LIMIT || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(body)) return 'Enter a task body of 1–4000 characters; only tabs and LF newlines are allowed as control input.'
  return ''
}
export function sameSeatDefinition(current, reviewed) {
  return Boolean(current && reviewed && current.key === reviewed.key && current.rigId === reviewed.rigId &&
    current.logicalId === reviewed.logicalId && current.session === reviewed.session && current.runtime === reviewed.runtime &&
    (current.model || null) === (reviewed.model || null) && (current.cwd || null) === (reviewed.cwd || null))
}
