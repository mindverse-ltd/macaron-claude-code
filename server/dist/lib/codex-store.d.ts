import type { SessionDetail, SessionListItem } from '@macaron/shared';
export declare function encodeCodexProjectName(cwd: string): string;
export declare function listCodexSessions(): Promise<SessionListItem[]>;
export declare function findCodexRolloutFile(sid: string): Promise<string | null>;
export declare function readCodexSessionMessages(sid: string): Promise<SessionDetail>;
export declare function deleteCodexSession(sid: string): Promise<void>;
//# sourceMappingURL=codex-store.d.ts.map