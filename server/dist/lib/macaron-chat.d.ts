import type { AttachedImage } from './claude-runner.js';
import type { SessionStreamEvent } from '@macaron/shared';
type Args = {
    project: string;
    sid: string;
    text: string;
    images: AttachedImage[];
};
export declare function runMacaronChat(args: Args, send: (ev: SessionStreamEvent) => void): Promise<void>;
export {};
//# sourceMappingURL=macaron-chat.d.ts.map