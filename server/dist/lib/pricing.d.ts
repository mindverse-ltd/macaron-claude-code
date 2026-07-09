export type ModelRates = {
    input: number;
    output: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    cacheRead: number;
};
export declare function rateFor(model: string | undefined | null): {
    rates: ModelRates;
    known: boolean;
};
export type UsageCounts = {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    ephemeral5m: number;
    ephemeral1h: number;
};
export declare function costOf(u: UsageCounts, rates: ModelRates): number;
//# sourceMappingURL=pricing.d.ts.map