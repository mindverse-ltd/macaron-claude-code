import type { FastifyReply } from 'fastify';
import { type IPty } from 'node-pty';
type PtySession = {
    proc: IPty;
    cwd: string;
    cols: number;
    rows: number;
    scrollback: string;
    subs: Set<FastifyReply>;
    exited: boolean;
    exitCode: number;
    reaper?: NodeJS.Timeout;
};
export declare function getOrCreatePty(tid: string, opts: {
    cwd: string;
    cols: number;
    rows: number;
}): PtySession;
export declare function ptySubscribe(tid: string, reply: FastifyReply): boolean;
export declare function ptyInput(tid: string, data: string): boolean;
export declare function ptyResize(tid: string, cols: number, rows: number): boolean;
export declare function killPty(tid: string): boolean;
export {};
//# sourceMappingURL=pty-registry.d.ts.map