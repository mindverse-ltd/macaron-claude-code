type LabelMap = Record<string, string>;
export declare function getLabels(): Promise<LabelMap>;
export declare function warmLabelsCache(): Promise<void>;
export declare function setLabel(sid: string, name: string): Promise<string>;
export declare function deleteLabel(sid: string): Promise<void>;
export {};
//# sourceMappingURL=label-store.d.ts.map