import type { PushSubscriptionPayload, PushNotifyPayload } from '@macaron/shared';
export declare function getVapidPublicKey(): Promise<string>;
export declare function saveSubscription(sub: PushSubscriptionPayload): Promise<void>;
export declare function removeSubscription(endpoint: string): Promise<void>;
export declare function sendPush(payload: PushNotifyPayload): Promise<void>;
//# sourceMappingURL=push-store.d.ts.map