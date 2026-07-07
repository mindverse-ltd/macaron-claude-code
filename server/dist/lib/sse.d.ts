import type { FastifyReply } from 'fastify';
import type { SessionStreamEvent } from '@macaron/shared';
export declare function startSSE(reply: FastifyReply): void;
export declare function sseSend(reply: FastifyReply, payload: SessionStreamEvent | Record<string, unknown>): void;
export declare function sseDone(reply: FastifyReply): void;
//# sourceMappingURL=sse.d.ts.map