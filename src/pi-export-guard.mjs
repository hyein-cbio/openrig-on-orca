// Bundled into a private Pi export only, never run in the plugin panel.
import DOMPurify from 'dompurify'

if (!globalThis.marked || typeof globalThis.marked.parse !== 'function') throw new Error('Unsupported Pi HTML renderer')
const parse = globalThis.marked.parse.bind(globalThis.marked)
globalThis.marked.parse = (...args) => {
  const html = parse(...args)
  if (typeof html !== 'string') throw new Error('Unsupported asynchronous Pi Markdown renderer')
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'meta', 'link', 'base', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'video', 'audio', 'source', 'img'],
    FORBID_ATTR: ['href', 'src', 'srcset', 'target', 'style', 'download'],
    ALLOW_DATA_ATTR: false
  })
}
// Snapshot content is not a navigation surface. Tool expansion/search remain local.
document.addEventListener('click', event => {
  if (event.target instanceof Element && event.target.closest('a[href],.download-json-btn')) { event.preventDefault(); event.stopImmediatePropagation() }
}, true)
