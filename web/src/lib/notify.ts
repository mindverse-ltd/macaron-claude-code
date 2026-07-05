// Browser notification helper. Silent no-op when the tab is currently
// focused (user's already looking), when the API is unavailable, or when
// the user has denied permission. Click-to-focus is wired in the caller
// via the `onClick` option.

export type NotifyOptions = {
  title: string;
  body?: string;
  // De-dupe key — repeated notifications with the same tag replace the
  // previous one rather than stacking (per browser Notification spec).
  tag?: string;
  // True while a permission gate is waiting for the user. Keeps the
  // notification visible until dismissed rather than auto-fading.
  requireInteraction?: boolean;
  onClick?: () => void;
};

function isTabActive(): boolean {
  // `document.hasFocus()` covers "window is on top". `document.hidden`
  // covers "tab is background". Either one being false means the user
  // won't see UI updates without a nudge.
  return !document.hidden && document.hasFocus();
}

let permissionAsked = false;

export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  if (permissionAsked) return Notification.permission;
  permissionAsked = true;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function notify(opts: NotifyOptions): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  if (isTabActive()) return;
  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      requireInteraction: opts.requireInteraction ?? false,
      icon: '/mindlab-symbol.svg',
      badge: '/mindlab-symbol.svg',
    });
    if (opts.onClick) {
      n.onclick = () => {
        try {
          window.focus();
        } catch { /* ignore */ }
        opts.onClick?.();
        n.close();
      };
    }
  } catch {
    /* browser refused (e.g. rate-limit) — silently drop */
  }
}
