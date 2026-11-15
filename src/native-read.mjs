import http from 'node:http'
import { fail } from './runtime.mjs'

// Closed read-only routes. Never follow redirects, use proxies, look up credentials or clean daemon files.
export function readNativeJson(endpoint, pathname, query, signal, maxBytes = 262144) {
  const allowed = new Set(['/api/whoami', '/api/queue/outbox/list'])
  const url = new URL(pathname, endpoint)
  if (!allowed.has(pathname) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576) throw fail('invalid_read', 'Only bounded local loopback metadata/outbox reads are supported')
  if (pathname === '/api/whoami' && query?.compact !== '1') throw fail('invalid_read', 'Whoami reads must explicitly use the token-free compact projection')
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
  return new Promise((resolve, reject) => {
    const timeout = AbortSignal.timeout(2500)
    http.get(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, agent: false }, response => {
      if (response.statusCode !== 200) { response.destroy(); reject(new Error('Native read unavailable')); return }
      const chunks = []; let bytes = 0
      response.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) response.destroy(new Error('Native response exceeds its read budget')); else chunks.push(chunk) })
      response.on('error', reject)
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('Invalid native response')) } })
    }).on('error', reject)
  })
}
