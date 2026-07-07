export declare const SYSTEM_PROVIDER_ID = "system";
export type CustomProvider = {
    id: string;
    name: string;
    endpoint: string;
    model: string;
    apiKey: string;
};
export type Settings = {
    activeProviderId: string;
    customProviders: CustomProvider[];
    yoloMode: boolean;
};
export type PublicCustomProvider = {
    id: string;
    name: string;
    endpoint: string;
    model: string;
    configured: boolean;
};
export type PublicBuiltinProvider = {
    id: 'system';
    name: string;
    description: string;
    detectedEndpoint: string | null;
};
export type PublicSettings = {
    activeProviderId: string;
    builtins: PublicBuiltinProvider[];
    customProviders: PublicCustomProvider[];
    yoloMode: boolean;
};
export declare function readSettings(): Promise<Settings>;
export declare function warmSettingsCache(): Promise<void>;
export declare function readPublicSettings(): Promise<PublicSettings>;
export declare function addProvider(input: Omit<CustomProvider, 'id'>): Promise<CustomProvider>;
export declare function updateProvider(id: string, patch: Partial<Omit<CustomProvider, 'id'>>): Promise<CustomProvider | null>;
export declare function deleteProvider(id: string): Promise<boolean>;
export declare function setActiveProvider(id: string): Promise<boolean>;
export declare function getActiveProviderRaw(): {
    id: string;
    name: string;
    endpoint: string;
    model: string;
    apiKey: string;
} | null;
export declare function getYoloMode(): boolean;
export declare function setYoloMode(enabled: boolean): Promise<void>;
export declare function getActiveProviderEnv(): {
    model: string | undefined;
    env: Record<string, string> | null;
};
//# sourceMappingURL=settings-store.d.ts.map