CREATE TABLE IF NOT EXISTS restaurants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  did_e164 text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_items (
  id uuid PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_modifiers (
  id uuid PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  menu_item_id uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS calls (
  openai_call_id text PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  from_uri text,
  to_uri text,
  status text NOT NULL DEFAULT 'INCOMING',
  draft_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  order_number text NOT NULL UNIQUE,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  call_id text REFERENCES calls(openai_call_id),
  customer_name text NOT NULL,
  customer_phone text,
  fulfillment text NOT NULL CHECK (fulfillment IN ('pickup', 'delivery')),
  delivery_address text,
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  status text NOT NULL CHECK (status IN ('NEW','CONFIRMED','PREPARING','READY','COMPLETED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id uuid REFERENCES menu_items(id),
  item_name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  modifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  line_total_cents integer NOT NULL CHECK (line_total_cents >= 0)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_restaurant_created_idx ON orders (restaurant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS menu_items_restaurant_idx ON menu_items (restaurant_id, active);
