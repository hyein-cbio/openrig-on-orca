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
export interface Workspace { id: string; name: string; project?: string | null; path: string; hostId: string | null }
export interface Seat {
  key: string; rigId: string; rigName: string; logicalId: string; session: string
  runtime: string; status: string; attention: boolean; activity: string; rigNameKnown?: boolean; lifecycle?: string; model?: string | null; cwd?: string | null
}
export interface ExampleRecord {
  id: string; kind: 'demo' | 'claude' | 'codex'; rigName: string; directory: string; specPath: string; configRoot: string
}
export interface Instruction { key: string; session: string; runtime: string; text: string }
export interface QueueTask { id: string; destination: string; key: string; runtime: string; summary: string; body: string; bodyFile: string }
export interface TaskStatus { id: string; destination: string; registration: 'unverified' | 'verified'; state: string; detail: string }
export interface NoOpReceipt { noOp: true; detail: string }
export interface Plan {
  id: string; expires: number; action: string; title: string; source: string
  writes: string[]; warnings: string[]; command: string; workspaceId: string; instruction?: Instruction; seatLaunch?: Seat; queueTask?: QueueTask; example?: ExampleRecord; launchReview?: { display: Record<string, unknown> }
}
export interface TerminalReceipt {
  terminalId: string; task?: TaskStatus; warning?: string; workspaceName?: string; workspaceId?: string; title?: string
  visibility?: 'shown' | 'unverified'; visibilityDetail?: string; recoveryCommand?: string
}
export interface State {
  config: Config; snapshot: Snapshot; workspaces: Workspace[]
  daemon: { status: 'not-installed' | 'unavailable' | 'reachable'; detail: string }
}

declare module 'orca' {
  interface PluginRequests {
    'environment.scan': { output: State }
    'config.save': { input: Config; output: State }
    'setup.prepare': { input: { action: string; workspaceId: string; spec?: string; exampleId?: string; seatKey?: string; message?: string; summary?: string; body?: string }; output: Plan }
    'examples.list': { output: { examples: ExampleRecord[] } }
    'setup.execute': { input: { planId: string; workspaceId: string; acceptStartupRisk?: boolean }; output: TerminalReceipt | NoOpReceipt }
    'task.check': { input: { id: string }; output: TaskStatus }
    'terminal.reveal': { input: { terminalId: string }; output: TerminalReceipt }
    'seats.list': { output: { seats: Seat[] } }
    'seat.attach': { input: { key: string; workspaceId: string; readOnly: boolean }; output: TerminalReceipt }
  }
}
