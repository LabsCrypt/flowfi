const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

/** Convert the VAPID public key (base64url) into the Uint8Array PushManager expects. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) output[i] = rawData.charCodeAt(i);
  return output;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register('/sw.js');
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export async function subscribeToPush(address: string): Promise<PushSubscription> {
  if (!isPushSupported()) throw new Error('Push notifications are not supported in this browser');
  if (!VAPID_PUBLIC_KEY) throw new Error('VAPID public key is not configured');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was denied');

  const registration = await registerServiceWorker();
  if (!registration) throw new Error('Failed to register service worker');

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
  });

  const json = subscription.toJSON();
  const response = await fetch('/api/v1/notifications/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address,
      endpoint: json.endpoint,
      keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
      userAgent: navigator.userAgent,
    }),
  });

  if (!response.ok) {
    await subscription.unsubscribe().catch(() => undefined);
    throw new Error('Failed to register subscription with the server');
  }

  return subscription;
}

export async function unsubscribeFromPush(address: string): Promise<void> {
  const subscription = await getExistingSubscription();
  if (!subscription) return;

  await fetch('/api/v1/notifications/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, endpoint: subscription.endpoint }),
  }).catch(() => undefined);

  await subscription.unsubscribe();
}
