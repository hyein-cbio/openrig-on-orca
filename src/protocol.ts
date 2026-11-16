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
  key: string; rigId: string; rigName: string; logicalId: string; session: string; podId?: string | null; podNamespace?: string | null
  runtime: string; status: string; attention: boolean; activity: string; rigNameKnown?: boolean; lifecycle?: string; model?: string | null; cwd?: string | null
}
export interface Pod { key: string; rigId: string; rigName: string; podId: string | null; namespace: string | null; label: string; seatCount: number }
export interface PodInventory { connection: { source: 'tui' | 'configured'; key: string; home: string; port: string; endpoint: string; matchesConfigured: boolean }; observedAt: number; pods: Pod[]; seats: Seat[] }
export interface PodRelations { instanceKey: string; podKey: string; memberKeys: string[]; observedAt: number; status: 'complete' | 'partial' | 'unavailable' | 'loading'; edges: { fromKey: string; toKey: string; kind: string }[]; omittedEdges?: number; notes: string[] }
export interface UserReport { id: string; title: string; titleTruncated?: boolean; source: string; destination: string; state: string; updatedAt: string; body: string; preview: string; bodyBytes: number; totalBytes: number; truncated: boolean }
export interface UserReports { instanceKey: string; podKey: string; seatKey: string; rigId: string; reportingSeat: string; sources: string[]; observedAt: number; status: 'ready' | 'partial' | 'unverified'; reports: UserReport[]; notes: string[]; truncated: boolean }
export interface ReportPreview { instanceKey: string; podKey: string; seatKey: string; observedAt: number; status: 'recorded' | 'none' | 'unverified'; detail: string; preview?: string; previewBytes?: number; totalBytes?: number; truncated?: boolean; recordId?: string; recordedAt?: string; recipient?: string; delivery?: string; kind?: string }
export interface ExampleRecord {
  id: string; kind: 'demo' | 'claude' | 'codex'; rigName: string; directory: string; specPath: string; configRoot: string; instance?: string
}
export interface Instruction { key: string; session: string; runtime: string; text: string; completion?: string }
export interface QueueTask { id: string; destination: string; key: string; runtime: string; summary: string; body: string; bodyFile: string }
export interface TaskStatus { id: string; destination: string; registration: 'unverified' | 'verified'; state: string; detail: string; resolution?: { body: string; bytes: number; totalBytes: number; truncated: boolean } }
export interface NoOpReceipt { noOp: true; detail: string }
export interface Plan {
  id: string; expires: number; action: string; title: string; source: string
  writes: string[]; warnings: string[]; command: string; workspaceId: string; consoleRuntime?: string; console?: { source: 'tui' | 'configured'; key: string; home: string; port: string; endpoint: string; cli: string; node: string; version: string }; pod?: { key: string; rigId: string; podId: string | null; namespace: string | null; instanceKey: string; endpoint: string }; instruction?: Instruction; seatLaunch?: Seat; queueTask?: QueueTask; example?: ExampleRecord; launchReview?: { display: Record<string, unknown> }
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
    'setup.prepare': { input: { action: string; workspaceId: string; spec?: string; exampleId?: string; seatKey?: string; message?: string; summary?: string; body?: string; podKey?: string; instanceKey?: string; consoleSource?: 'tui' | 'configured' }; output: Plan }
    'examples.list': { output: { examples: ExampleRecord[] } }
    'setup.execute': { input: { planId: string; workspaceId: string; acceptStartupRisk?: boolean }; output: TerminalReceipt | NoOpReceipt }
    'task.check': { input: { id: string }; output: TaskStatus }
    'terminal.reveal': { input: { terminalId: string }; output: TerminalReceipt }
    'pods.list': { input: { source: 'tui' | 'configured' } | undefined; output: PodInventory }
    'pods.edges': { input: { source: 'tui' | 'configured'; instanceKey: string; podKey: string }; output: PodRelations }
    'user.reports': { input: { source: 'tui' | 'configured'; instanceKey: string; podKey: string; seatKey: string; sources: string[] }; output: UserReports }
    'seat.report': { input: { source: 'tui' | 'configured'; instanceKey: string; podKey: string; seatKey: string }; output: ReportPreview }
    'pods.connect': { input: { source: 'tui' | 'configured'; expectedKey: string }; output: State }
    'seats.list': { output: { seats: Seat[] } }
    'seat.attach': { input: { key: string; workspaceId: string; readOnly: boolean; podKey?: string; instanceKey?: string }; output: TerminalReceipt }
  }
}
