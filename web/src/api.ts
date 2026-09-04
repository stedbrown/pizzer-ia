import type { Callback, Conversation, LiveLogEvent, MenuItem, OrderStatus, OrderView, ServiceSettings, ServiceStatus } from '../../src/types';

export interface TelephonyView {
  provider: string; plan: string; number: string;
  asteriskOnline: boolean | null; sipRegistration: string; version?: string;
  checkedAt: string | null; heartbeatState: 'unknown' | 'stale' | 'current';
  inboundStatus: string; audioStatus: string; openaiRealtime: string;
  realtimeModel: string; voice: string; turnDetection: string; humanTransfer: boolean;
  backendOnline: boolean; databaseOnline: boolean;
}

export interface UsageView {
  calls: number; durationSeconds: number; orders: number; orderValueCents: number;
  openaiCostUsdMicros: number; usageSource: 'REAL' | 'N/D';
  sipcallMonthlyChfCents: number;
}

export interface ServiceView {
  settings: ServiceSettings;
  status: ServiceStatus;
  smsConfigured: boolean;
  humanTransfer: boolean;
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Errore ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  orders: () => request<OrderView[]>('/api/orders'),
  setOrderStatus: (id: string, status: OrderStatus) =>
    request<{ ok: true }>(`/api/orders/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  menu: () => request<MenuItem[]>('/api/menu'),
  patchMenuItem: (id: string, patch: Record<string, unknown>) =>
    request<MenuItem>(`/api/menu/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  service: () => request<ServiceView>('/api/service'),
  patchService: (patch: Partial<ServiceSettings>) =>
    request<{ settings: ServiceSettings; status: ServiceStatus }>('/api/service', { method: 'PATCH', body: JSON.stringify(patch) }),
  callbacks: () => request<Callback[]>('/api/callbacks'),
  resolveCallback: (id: string) => request<{ ok: true }>(`/api/callbacks/${encodeURIComponent(id)}/resolve`, { method: 'POST' }),
  telephony: () => request<TelephonyView>('/api/telephony/status'),
  usage: () => request<UsageView>('/api/usage/monthly'),
  conversations: () => request<Conversation[]>('/api/conversations?limit=10'),
  logs: () => request<LiveLogEvent[]>('/api/live-logs?limit=300'),
  testMode: () => request<{ enabled: boolean; expiresAt: string | null }>('/api/test-mode'),
  setTestMode: (enabled: boolean) =>
    request<{ enabled: boolean; expiresAt: string | null }>('/api/test-mode', { method: 'POST', body: JSON.stringify({ enabled }) })
};
