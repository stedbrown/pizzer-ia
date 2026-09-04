export type Fulfillment = 'pickup' | 'delivery';
export type OrderStatus = 'NEW' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED';

export interface Modifier {
  id: string;
  name: string;
  priceCents: number;
  active: boolean;
  /** 'remove' è una rinuncia ("senza mozzarella"), 'add' è un supplemento a pagamento. */
  kind: 'add' | 'remove';
}

export interface MenuItem {
  id: string;
  restaurantId: string;
  name: string;
  description?: string;
  category?: string;
  allergens: string[];
  priceCents: number;
  active: boolean;
  /** Finito per oggi: si azzera da solo il giorno dopo. */
  soldOutUntil?: string;
  modifiers: Modifier[];
}

export interface OpeningSlot {
  weekday: number;
  opens: string;
  closes: string;
}

export interface ServiceSettings {
  timezone: string;
  prepMinutes: number;
  deliveryExtraMinutes: number;
  busyExtraMinutes: number;
  busyMode: boolean;
  acceptsDelivery: boolean;
  hours: OpeningSlot[];
}

export interface ServiceStatus {
  open: boolean;
  busyMode: boolean;
  acceptsDelivery: boolean;
  localTime: string;
  todayHours: OpeningSlot[];
  closesAt?: string;
  opensAt?: string;
  pickupMinutes: number;
  deliveryMinutes?: number;
}

export interface Callback {
  id: string;
  callId?: string;
  phone?: string;
  reason: string;
  createdAt: string;
  handledAt?: string;
}

export interface DraftLine {
  id: string;
  itemId: string;
  quantity: number;
  modifierIds: string[];
}

export interface DraftOrder {
  restaurantId: string;
  callId: string;
  callerPhone?: string;
  customerName?: string;
  fulfillment?: Fulfillment;
  deliveryAddress?: string;
  lines: DraftLine[];
  summaryPresentedAt?: string;
  confirmedOrderId?: string;
}

export interface OrderView {
  id: string;
  orderNumber: string;
  restaurantId: string;
  customerName: string;
  customerPhone?: string;
  fulfillment: Fulfillment;
  deliveryAddress?: string;
  totalCents: number;
  status: OrderStatus;
  createdAt: string;
  readyAt?: string;
  notifiedAt?: string;
  items: Array<{ name: string; quantity: number; unitPriceCents: number; modifiers: Modifier[]; lineTotalCents: number }>;
}

export interface IncomingCall {
  callId: string;
  from?: string;
  to?: string;
  restaurantId: string;
}

export type CheckState = 'waiting' | 'ok' | 'error';
export type RealtimeState = 'waiting' | 'ready' | 'connected' | 'error';
export type SipRegistration = 'registered' | 'unregistered' | 'unknown';

export interface TelephonyHeartbeat {
  asteriskOnline: boolean;
  sipRegistration: SipRegistration;
  version?: string;
  checkedAt: string;
}

export interface TelephonyStatus extends TelephonyHeartbeat {
  inboundStatus: CheckState;
  audioStatus: CheckState;
  openaiRealtime: RealtimeState;
}

export interface CallUsage {
  audioInputTokens: number;
  audioOutputTokens: number;
  textInputTokens: number;
  textOutputTokens: number;
  openaiCostUsdMicros: number;
}

export interface MonthlyUsage extends CallUsage {
  calls: number;
  durationSeconds: number;
  orders: number;
  orderValueCents: number;
  usageSource: 'REAL' | 'N/D';
}

export type LogSource = 'ASTERISK' | 'SIPCALL' | 'SIP' | 'CALL' | 'RTP' | 'HEARTBEAT' | 'USER' | 'AGENT' | 'OPENAI' | 'WEBHOOK' | 'SIDEBAND' | 'TOOL' | 'ORDER' | 'DB' | 'BACKEND';

export interface ConversationTurn {
  at: string;
  offsetMs: number;
  role: 'customer' | 'agent' | 'tool' | 'system';
  text: string;
  /** Attesa fra la fine del parlato del cliente e l'inizio della risposta. */
  latencyMs?: number;
  bargeIn?: boolean;
}

export interface ConversationMetrics {
  customerTurns: number;
  agentTurns: number;
  toolCalls: number;
  bargeIns: number;
  avgResponseMs?: number;
  slowestResponseMs?: number;
}

export interface Conversation {
  callId: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  outcome: 'confermato' | 'trasferita' | 'in corso' | 'chiusa';
  headline?: string;
  metrics: ConversationMetrics;
  turns: ConversationTurn[];
}
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type LogCategory = 'TELEPHONY' | 'OPENAI' | 'BACKEND' | 'TOOL' | 'DATABASE';

export interface NewLiveLogEvent {
  source: LogSource;
  level: LogLevel;
  category: LogCategory;
  message: string;
  callId?: string;
  timestamp?: string;
}

export interface LiveLogEvent extends NewLiveLogEvent {
  id: string;
  restaurantId: string;
  timestamp: string;
}
