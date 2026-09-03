export type Fulfillment = 'pickup' | 'delivery';
export type OrderStatus = 'NEW' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED';

export interface Modifier {
  id: string;
  name: string;
  priceCents: number;
  active: boolean;
}

export interface MenuItem {
  id: string;
  restaurantId: string;
  name: string;
  description?: string;
  priceCents: number;
  active: boolean;
  modifiers: Modifier[];
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
  items: Array<{ name: string; quantity: number; unitPriceCents: number; modifiers: Modifier[]; lineTotalCents: number }>;
}

export interface IncomingCall {
  callId: string;
  from?: string;
  to?: string;
  restaurantId: string;
}
