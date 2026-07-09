import type { GitStatus, GitBranches } from '@macaron/shared';
export declare function resolveProjectCwd(project: string): Promise<string>;
export declare class GitError extends Error {
    readonly code: number | null;
    constructor(message: string, code: number | null);
}
export declare function status(cwd: string): Promise<GitStatus>;
export declare function diff(cwd: string, file: string, opts?: {
    staged?: boolean;
    untracked?: boolean;
}): Promise<string>;
export declare function stage(cwd: string, files: string[]): Promise<void>;
export declare function unstage(cwd: string, files: string[]): Promise<void>;
export declare function commit(cwd: string, message: string, all: boolean): Promise<string>;
export declare function branches(cwd: string): Promise<GitBranches>;
export declare function checkout(cwd: string, branch: string, create: boolean): Promise<string>;
//# sourceMappingURL=git.d.ts.map