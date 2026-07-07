import type { SessionDetail, SessionListItem, Workspace } from '@macaron/shared';
export declare function basename(p: string): string;
export declare function decodeClaudeProjectName(encoded: string): string;
type SessionSummary = {
    firstUserText: string;
    cwd: string;
    gitBranch: string;
    headLines: number;
    truncated: boolean;
    mtime: number;
    size: number;
};
export declare function deleteSession(project: string, sid: string): Promise<void>;
export declare function duplicateSession(project: string, sid: string): Promise<{
    newSid: string;
}>;
export declare function rewindSession(project: string, sid: string, uuid: string): Promise<{
    dropped: number;
    backupPath: string;
}>;
export declare function writeCompactedSession(project: string, sid: string, summary: string): Promise<{
    backupPath: string;
    kept: number;
}>;
export declare function readSessionSummary(filePath: string): Promise<SessionSummary | null>;
export declare function listAllSessions(): Promise<SessionListItem[]>;
export declare function groupWorkspaces(sessions: SessionListItem[]): Workspace[];
export declare function readSessionMessages(project: string, sid: string): Promise<SessionDetail>;
export {};
//# sourceMappingURL=session-store.d.ts.map