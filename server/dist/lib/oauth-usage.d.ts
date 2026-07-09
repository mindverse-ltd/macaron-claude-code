export type RateLimitWindow = {
    utilization: number;
    resetsAt: string | null;
};
export type OAuthUsage = {
    fiveHour: RateLimitWindow | null;
    sevenDay: RateLimitWindow | null;
};
export declare function fetchOAuthUsage(): Promise<OAuthUsage | null>;
//# sourceMappingURL=oauth-usage.d.ts.map