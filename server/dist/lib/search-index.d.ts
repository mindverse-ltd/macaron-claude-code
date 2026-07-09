import type { SearchHit } from '@macaron/shared';
export declare const DB_PATH: string;
export declare function isSearchEnabled(): boolean;
export type { SearchHit };
export declare function syncAll(): Promise<{
    scanned: number;
    changed: number;
}>;
export declare function search(query: string, limit?: number): Promise<SearchHit[]>;
export declare function indexStats(): {
    files: number;
    messages: number;
    lastSyncAt: number;
};
//# sourceMappingURL=search-index.d.ts.map