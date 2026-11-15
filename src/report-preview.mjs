// Byte budget applies only to the body excerpt. Labels, provenance and truncation notices are separate.
export const REPORT_PREVIEW_BYTES = 500
export function reportPrefix(body) {
  if (typeof body !== 'string') throw new Error('A recorded text body is required')
  const bytes = new TextEncoder().encode(body)
  let end = Math.min(bytes.length, REPORT_PREVIEW_BYTES)
  while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  const preview = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, end))
  return { preview, previewBytes: end, totalBytes: bytes.length, truncated: end < bytes.length }
}
