import type { ConfigFile, ConfigFileId, ConfigFileMeta } from '@macaron/shared';
export declare function isConfigFileId(id: string): id is ConfigFileId;
export declare function listConfigFiles(): Promise<ConfigFileMeta[]>;
export declare function readConfigFile(id: ConfigFileId): Promise<ConfigFile>;
export declare function validateSettingsJson(content: string): string | null;
export declare function writeConfigFile(id: ConfigFileId, content: string): Promise<ConfigFile>;
//# sourceMappingURL=config-files.d.ts.map