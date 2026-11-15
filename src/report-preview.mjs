// Byte budget applies only to the body excerpt. Labels, provenance and truncation notices are separate.
export const REPORT_PREVIEW_BYTES = 500
export const reportPrefix = body => utf8Excerpt(body, REPORT_PREVIEW_BYTES)
export function utf8Excerpt(body, limit) {
  if (typeof body !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 16384) throw new Error('A bounded recorded text body is required')
  const bytes = new TextEncoder().encode(body)
  let end = Math.min(bytes.length, limit)
  while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  const preview = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, end))
  return { preview, previewBytes: end, totalBytes: bytes.length, truncated: end < bytes.length }
}
