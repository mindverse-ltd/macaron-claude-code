import type { FastifyReply } from 'fastify';
import type { SessionStreamEvent } from '@macaron/shared';
type LiveSession = {
    events: SessionStreamEvent[];
    subs: Set<FastifyReply>;
    ended: boolean;
};
export declare function liveStart(sid: string, meta: {
    cwd: string;
}): void;
export declare function livePush(sid: string, payload: SessionStreamEvent): void;
export declare function liveEnd(sid: string, payload: SessionStreamEvent): void;
export declare function liveGet(sid: string): LiveSession | undefined;
export {};
//# sourceMappingURL=live-registry.d.ts.map