import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
export declare function isLoopback(ip: string | undefined): boolean;
export declare function isLoopbackHost(host: string): boolean;
export declare function tokensMatch(a: string, b: string): boolean;
export declare function resolveToken(host: string, configured: string): {
    token: string;
    generated: boolean;
};
export declare function extractToken(req: FastifyRequest): string;
export declare function redactTokenInUrl(url: string): string;
export declare function makeAuthHook(token: string): (req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => void;
//# sourceMappingURL=auth.d.ts.map