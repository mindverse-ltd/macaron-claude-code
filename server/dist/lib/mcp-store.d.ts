export type McpTransport = 'stdio' | 'http' | 'sse';
export type PublicMcpServer = {
    name: string;
    transport: McpTransport;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    alwaysLoad?: boolean;
};
export type McpServerInput = {
    name: string;
    transport: McpTransport;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
};
export type MutationError = {
    status: number;
    message: string;
};
export declare function readPublicMcpServers(): Promise<PublicMcpServer[]>;
export declare function addServer(input: McpServerInput): Promise<{
    ok: true;
} | MutationError>;
export declare function updateServer(oldName: string, input: McpServerInput): Promise<{
    ok: true;
} | MutationError>;
export declare function deleteServer(name: string): Promise<{
    ok: true;
} | MutationError>;
//# sourceMappingURL=mcp-store.d.ts.map