import type { State, Plan } from './protocol'

export const missing: State = {
  config: { provider: 'none', root: '/sandbox/openrig', daemonPort: '43811', nodePath: '', npmPath: '', rigPath: '', tmuxPath: '', extraPath: '', homePath: '', codexHome: '', claudeConfigDir: '' },
  snapshot: {
    platform: 'darwin', arch: 'arm64', config: {} as State['config'],
    nodes: [{ path: '/tools/node', version: 'v22.23.1', compatible: true }],
    tools: { node: '/tools/node', npm: '/tools/npm', tmux: '/tools/tmux', rig: null, claude: null, codex: null },
    rigVersion: null, tmuxVersion: 'tmux 3.8', sqlite: { status: 'unavailable', detail: 'Install OpenRig with the selected Node first.' },
    providers: [], stage: 'dependencies-missing', installed: false, ready: false
  },
  daemon: { status: 'not-installed', detail: 'Install and verify OpenRig, tmux and SQLite first.' },
  workspaces: [{ id: 'workspace', name: 'Plugin sandbox', path: '/sandbox/project', hostId: 'local' }]
}
missing.snapshot.config = missing.config

export const installed: State = {
  ...missing,
  daemon: { status: 'unavailable', detail: 'Start daemon · no agents, then Recheck environment.' },
  snapshot: { ...missing.snapshot, tools: { ...missing.snapshot.tools, rig: '/sandbox/runtime/rig' },
    rigVersion: '0.7.13', sqlite: { status: 'ready', detail: 'SQLite loaded and queried with the selected Node.' },
    stage: 'installed-agent-deferred', installed: true }
}

export const ready: State = {
  ...installed,
  daemon: { status: 'reachable', detail: 'This instance responded.' },
  config: { ...installed.config, provider: 'both' },
  snapshot: { ...installed.snapshot, stage: 'ready', ready: true,
    providers: [{ provider: 'claude', path: '/tools/claude', status: 'authenticated' }, { provider: 'codex', path: '/tools/codex', status: 'authenticated' }] }
}
ready.snapshot.config = ready.config

export const installPlan: Plan = {
  id: 'plan-1', expires: 9999999999999, action: 'install-rig', title: 'Install OpenRig 0.7.13',
  source: 'https://github.com/mvschwarz/openrig', writes: ['/sandbox/openrig/runtime', 'npm cache'],
  warnings: ['Downloads official npm packages and runs their install scripts, including native SQLite installation.'],
  workspaceId: 'workspace', command: "npm install --prefix '/sandbox/openrig/runtime' '@openrig/cli@0.7.13'"
}
