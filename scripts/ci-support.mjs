import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Orca v1.4.258 upstream fixture contract. This is not a general --skip-onboarding flag.
// https://github.com/stablyai/orca/blob/v1.4.258/tests/e2e/helpers/orca-app.ts
export function isolatedProfileSeed() {
  return {
    settings: { telemetry: { optedIn: false, installId: '00000000-0000-4000-8000-000000000000', existedBeforeTelemetryRelease: false } },
    onboarding: { flowVersion: 4, closedAt: 1, outcome: 'dismissed', lastCompletedStep: -1 },
    ui: {
      featureTipsSeenIds: ['chat-ui-here', 'chat-ui-here-rollout-v1', 'agent-session-search', 'orca-cli', 'cmd-j-palette', 'voice-dictation'],
      contextualToursSeenIds: ['workspace-board', 'browser', 'tasks', 'automations', 'workspace-creation'],
      contextualToursAutoEligible: false, projectOrderManualDefaultNoticeDismissed: true,
      browserImportHintHidden: true, usagePercentageDisplayChangeNoticeDismissed: true,
      statusBarCompactChangeNoticeDismissed: true, codexTerminalServerIsolationNoticeSeen: true
    }
  }
}
export async function seedFreshOrcaProfile(directory) {
  await mkdir(directory, { recursive: true })
  if ((await readdir(directory)).length) throw new Error('Onboarding seed requires a new empty test profile; existing profiles are never modified')
  await writeFile(path.join(directory, 'orca-data.json'), JSON.stringify(isolatedProfileSeed(), null, 2) + '\n', { flag: 'wx' })
}

export function cleanCiEnvironment(source) {
  const allowed = /^(?:PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|USER|LOGNAME|SHELL|TERM|DISPLAY|XDG_RUNTIME_DIR|__CF_USER_TEXT_ENCODING|NPM_CONFIG_CACHE|HOMEBREW_NO_AUTO_UPDATE|ORCA_CLI_COMMAND|OPENRIG_TEST_RIG)$/
  return { ...Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key))), CI: 'true' }
}

export function processSampleState(sample, roots) {
  if (!sample.trim() || /^\s*Z/.test(sample)) return 'gone'
  if (roots.some(root => sample.includes(root))) return 'owned'
  if (sample.trim().split(/\s+/)[0].includes('E')) return 'exiting'
  return 'unproven'
}

export function optionValue(argv, name) {
  const index = argv.indexOf(name)
  if (index < 0) return null
  if (!argv[index + 1] || argv[index + 1].startsWith('--') || argv.indexOf(name, index + 1) >= 0) throw new Error(`Provide one value for ${name}`)
  return argv[index + 1]
}

export const LIVE_CHECKS = ['runtime-verified', 'daemon-opened', 'daemon-no-agents', 'example-opened', 'two-seats', 'pod-inventory', 'native-relationships', 'seat-attached', 'detach-preserves-seat', 'example-stopped', 'templates-validated', 'frozen-launch-review', 'frozen-terminal-launch', 'unified-panel', 'topology-layout', 'report-tooltip', 'cleanup-complete']
export function assertLiveReport(report, { install = false } = {}) {
  if (report.exitCode !== 0 || report.error) throw new Error('Live suite did not succeed')
  const required = [...LIVE_CHECKS, ...(install ? ['install-opened', 'first-install'] : [])]
  for (const id of required) if (report.checks.filter(check => check.id === id).length !== 1) throw new Error(`Missing or duplicate live check: ${id}`)
  if (report.versions?.orca !== '1.4.258' || !report.versions?.node?.startsWith('v22.')) throw new Error('Live report runtime does not match the pinned compatibility target')
  if (report.visual !== 'captured-seeded-profile') throw new Error('Unified panel capture is missing')
}
