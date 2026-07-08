import type { TunnelProvider, TunnelState } from '@macaron/shared';
export declare function getTunnelState(): TunnelState;
export declare function startTunnel(provider: TunnelProvider): Promise<TunnelState>;
export declare function stopTunnel(): TunnelState;
export declare function shutdownTunnel(): void;
//# sourceMappingURL=tunnel-manager.d.ts.map