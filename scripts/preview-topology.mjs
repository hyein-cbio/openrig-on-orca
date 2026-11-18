#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Static allowlist only. YAML is read by the browser and is never uploaded here. */
export async function startTopologyPreview(port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Use a port between 0 and 65535')
  const assets = JSON.parse(await readFile(path.join(root, 'src', 'visualizer', 'assets.json'), 'utf8'))
  const routes = new Map([['/topology.html', path.join(root, 'src', 'topology.html')], ['/topology.css', path.join(root, 'src', 'topology.css')], ['/plugin.css', path.join(root, 'src', 'plugin.css')], ['/pi-live.css', path.join(root, 'src', 'pi-live.css')]])
  for (const file of assets.files) routes.set(`/visualizer/${file.path}`, path.join(root, 'src', 'visualizer', file.path))
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'none'; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return }
    let pathname
    try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname) } catch { response.writeHead(400); response.end(); return }
    if (pathname === '/') { response.writeHead(302, { Location: '/visualizer/plugin.html' }); response.end(); return }
    const file = routes.get(pathname)
    if (!file) { response.writeHead(404); response.end(); return }
    try {
      const data = await readFile(file)
      response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8')
      response.writeHead(200); response.end(request.method === 'HEAD' ? undefined : data)
    } catch { response.writeHead(404); response.end() }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return { server, url: `http://127.0.0.1:${server.address().port}/` }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const preview = await startTopologyPreview(Number(process.argv[2] || 0))
  console.log(JSON.stringify({ url: preview.url, readOnly: true, uploads: false }))
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { preview.server.closeAllConnections(); preview.server.close() })
}
