import type { DEFAULT_CONFIG } from './runtime.mjs'
export type Config = typeof DEFAULT_CONFIG
export interface Tool { path: string; version: string; compatible: boolean }
export interface Snapshot {
  platform: string; arch: string; config: Config; nodes: Tool[]
  tools: Record<string, string | null>; rigVersion: string | null; tmuxVersion: string | null
  sqlite: { status: string; detail: string }
  providers: { provider: string; path: string | null; status: string }[]
  stage: string; installed: boolean; ready: boolean
}
export interface Workspace { id: string; name: string; path: string; hostId: string | null }
export interface Seat {
  key: string; rigId: string; rigName: string; logicalId: string; session: string
  runtime: string; status: string; attention: boolean; activity: string
}
export interface ExampleRecord {
  id: string; kind: 'demo' | 'claude' | 'codex'; rigName: string; directory: string; specPath: string; configRoot: string
}
export interface Plan {
  id: string; expires: number; action: string; title: string; source: string
  writes: string[]; warnings: string[]; command: string; workspaceId: string; example?: ExampleRecord; launchReview?: { display: Record<string, unknown> }
}
export interface State { config: Config; snapshot: Snapshot; workspaces: Workspace[] }

declare module 'orca' {
  interface PluginRequests {
    'environment.scan': { output: State }
    'config.save': { input: Config; output: State }
    'setup.prepare': { input: { action: string; workspaceId: string; spec?: string; exampleId?: string }; output: Plan }
    'examples.list': { output: { examples: ExampleRecord[] } }
    'setup.execute': { input: { planId: string; workspaceId: string }; output: { terminalId: string; warning?: string } }
    'seats.list': { output: { seats: Seat[] } }
    'seat.attach': { input: { key: string; workspaceId: string; readOnly: boolean }; output: { terminalId: string; warning?: string } }
  }
}
