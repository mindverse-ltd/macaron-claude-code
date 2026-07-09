import type { AgentFile } from '@macaron/shared';
export declare function isValidAgentName(name: string): boolean;
export declare function parse(raw: string, name: string): AgentFile;
export declare function serialize(a: AgentFile): string;
export declare function listAgents(): Promise<AgentFile[]>;
export declare function readAgent(name: string): Promise<AgentFile | null>;
export declare function writeAgent(a: AgentFile): Promise<AgentFile>;
export declare function deleteAgent(name: string): Promise<boolean>;
//# sourceMappingURL=agents-store.d.ts.map