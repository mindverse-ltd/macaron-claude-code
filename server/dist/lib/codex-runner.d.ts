import type { RunnerEvent, AttachedImage } from './claude-runner.js';
export type CodexRunOptions = {
    prompt: string;
    cwd: string;
    /** Resume an existing thread_id. Omit for a new thread. */
    resume?: string;
    abortController?: AbortController;
    images?: AttachedImage[];
};
export declare function runCodex(opts: CodexRunOptions): AsyncGenerator<RunnerEvent>;
//# sourceMappingURL=codex-runner.d.ts.map