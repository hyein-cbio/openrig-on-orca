// Node-only test builder. Invoked as a child, never imported by Orca's no-bare-import loader.
import { build } from 'esbuild'
const result = await build({ entryPoints: ['src/topology-client.mjs'], bundle: true, write: false, platform: 'browser', format: 'cjs',
  target: 'es2022', tsconfigRaw: {}, plugins: [{ name: 'test-browser-dependencies', setup(build) {
    build.onResolve({ filter: /^(dompurify|\.\/mermaid\/mermaid\.esm\.min\.mjs)$/ }, args => ({ path: args.path, namespace: 'test-browser' }))
    build.onLoad({ filter: /.*/, namespace: 'test-browser' }, args => ({ contents: `export default globalThis.${args.path === 'dompurify' ? '__purify' : '__mermaid'}` }))
  } }] })
process.stdout.write(result.outputFiles[0].text)
