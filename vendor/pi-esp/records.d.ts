type Row = {
    key: string;
    at?: string;
};
export type TranscriptEvent = Row & ({
    kind: 'user' | 'assistant' | 'thinking' | 'notice' | 'error';
    text: string;
} | {
    kind: 'tool-call';
    callId?: string;
    name: string;
    target: string;
} | {
    kind: 'tool-result';
    callId?: string;
    name: string;
    output: string;
    failed: boolean;
    diff?: string;
} | {
    kind: 'shell';
    command: string;
    output: string;
    failed: boolean;
});
