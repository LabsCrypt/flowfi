import { fetchWithTimeout, getApiBaseUrl } from "@/lib/api/_shared";

export const WEBHOOK_EVENT_TYPES = [
  "STREAM_CREATED",
  "TOKENS_WITHDRAWN",
  "STREAM_CANCELLED",
  "STREAM_PAUSED",
  "STREAM_TOPPED_UP",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookSubscription {
  id: string;
  userAddress: string;
  targetUrl: string;
  eventTypes: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventType: string;
  payload: string;
  responseStatus: number | null;
  responseBody?: string | null;
  attempts: number;
  deliveredAt: string | null;
  error: string | null;
  createdAt: string;
  latencyMs?: number | null;
}

export interface WebhookTestResult {
  success: boolean;
  status?: number;
  error?: string;
}

function endpoint(path = ""): string {
  const base = getApiBaseUrl();
  return `${base}${base.endsWith("/v1") ? "" : "/v1"}/webhooks${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithTimeout(endpoint(path), {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Webhook request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function listWebhooks(userAddress: string): Promise<WebhookSubscription[]> {
  const result = await request<{ subscriptions: WebhookSubscription[] }>(
    `?userAddress=${encodeURIComponent(userAddress)}`,
  );
  return result.subscriptions;
}

export async function createWebhook(input: {
  userAddress: string;
  targetUrl: string;
  eventTypes: string[];
}): Promise<{ subscription: WebhookSubscription; secretKey: string }> {
  return request("", { method: "POST", body: JSON.stringify(input) });
}

export async function updateWebhook(
  id: string,
  userAddress: string,
  input: { targetUrl?: string; eventTypes?: string[]; isActive?: boolean },
): Promise<WebhookSubscription> {
  return request(`/${id}?userAddress=${encodeURIComponent(userAddress)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteWebhook(id: string, userAddress: string): Promise<void> {
  await request(`/${id}?userAddress=${encodeURIComponent(userAddress)}`, {
    method: "DELETE",
  });
}

export async function listWebhookDeliveries(
  id: string,
  userAddress: string,
  page = 1,
  limit = 20,
): Promise<{ deliveries: WebhookDelivery[]; total: number; page: number; limit: number }> {
  return request(
    `/${id}/deliveries?userAddress=${encodeURIComponent(userAddress)}&page=${page}&limit=${limit}`,
  );
}

export async function sendWebhookTest(id: string, userAddress: string): Promise<WebhookTestResult> {
  const result = await request<{ result: WebhookTestResult }>(`/${id}/test`, {
    method: "POST",
    body: JSON.stringify({ userAddress }),
  });
  return result.result;
}

export async function regenerateWebhookSecret(id: string, userAddress: string): Promise<string> {
  const result = await request<{ secretKey: string }>(`/${id}/secret`, {
    method: "POST",
    body: JSON.stringify({ userAddress }),
  });
  return result.secretKey;
}