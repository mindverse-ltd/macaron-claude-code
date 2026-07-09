export type ShareEntry = {
    token: string;
    project: string;
    sid: string;
    createdAt: number;
};
export declare function createShare(project: string, sid: string): Promise<string>;
export declare function warmShareCache(): Promise<void>;
export declare function resolveShare(token: string): Promise<ShareEntry | null>;
export declare function deleteShareBySession(project: string, sid: string): Promise<boolean>;
//# sourceMappingURL=share-store.d.ts.map