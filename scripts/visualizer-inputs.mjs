// Shared source inventory for reproducible HTML-panel builds and safe staging.
export const visualizerInputs = [
  'package-lock.json', 'scripts/build-visualizer.mjs', 'scripts/visualizer-inputs.mjs',
  'src/pi-export-guard.mjs', 'src/pi-live-controller.ts', 'src/pi-live-view.ts', 'src/pi-live.css', 'src/example-story.mjs', 'src/user-report-projection.mjs', 'src/refresh-loop.mjs', 'src/report-preview.mjs', 'src/pods.mjs', 'src/plugin-client.mjs', 'src/plugin-state.mjs', 'src/plugin.css', 'src/plugin.html',
  'src/seat-instructions.mjs', 'src/seat-tasks.mjs', 'src/topology-client.mjs', 'src/topology.css',
  'src/topology.html', 'src/topology.mjs', 'src/topology-view.mjs', 'src/workspace-labels.mjs',
  'vendor/babel-helpers/LICENSE', 'vendor/orca-native-chat/LICENSE', 'vendor/orca-native-chat/SOURCE.md',
  ...['LICENSE', 'SOURCE.md', 'view.js', 'view.d.ts', 'view.css', 'markdown.js', 'records.d.ts'].map(file => `vendor/pi-esp/${file}`)
].sort()
