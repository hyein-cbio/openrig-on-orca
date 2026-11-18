import type { TranscriptEvent } from './records.js';
export interface TranscriptView {
    append(events: readonly TranscriptEvent[]): void;
    clear(): void;
    jumpToLatest(): void;
    dispose(): void;
}
/** Mount an Orca-inspired, read-only transcript. The caller owns data and polling. */
export declare function mountTranscript(root: HTMLElement): TranscriptView;
