-- Impostazioni di servizio: senza queste l'agente non sa se siete aperti né quanto ci vuole.
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Europe/Zurich',
  ADD COLUMN IF NOT EXISTS prep_minutes integer NOT NULL DEFAULT 20 CHECK (prep_minutes BETWEEN 1 AND 180),
  ADD COLUMN IF NOT EXISTS delivery_extra_minutes integer NOT NULL DEFAULT 15 CHECK (delivery_extra_minutes BETWEEN 0 AND 120),
  ADD COLUMN IF NOT EXISTS busy_extra_minutes integer NOT NULL DEFAULT 15 CHECK (busy_extra_minutes BETWEEN 0 AND 120),
  ADD COLUMN IF NOT EXISTS busy_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS accepts_delivery boolean NOT NULL DEFAULT true;

-- Fasce orarie: più righe per giorno coprono la pausa fra pranzo e cena. 0 = domenica.
CREATE TABLE IF NOT EXISTS restaurant_hours (
  id uuid PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens time NOT NULL,
  closes time NOT NULL
  -- closes <= opens significa che la fascia supera la mezzanotte (18:00 → 00:30).
);
CREATE INDEX IF NOT EXISTS restaurant_hours_idx ON restaurant_hours (restaurant_id, weekday);

-- Menu: categoria per proporre senza recitare, allergeni per rispondere con un fatto,
-- e "finito per oggi" che si azzera da solo il giorno dopo.
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS allergens text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS sold_out_until date;

-- Un extra con menu_item_id nullo vale per tutti i prodotti: catalogo condiviso
-- senza duplicare una riga per pizza. kind distingue le aggiunte dalle rimozioni.
ALTER TABLE menu_modifiers ALTER COLUMN menu_item_id DROP NOT NULL;
ALTER TABLE menu_modifiers ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'add' CHECK (kind IN ('add', 'remove'));
UPDATE menu_modifiers SET kind = 'remove' WHERE price_cents = 0 AND name ILIKE 'senza %' AND kind <> 'remove';

-- Quando non c'è nessuno a cui passare la chiamata, si prende un recapito invece di lasciare il silenzio.
CREATE TABLE IF NOT EXISTS callbacks (
  id uuid PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  call_id text,
  phone text,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  handled_at timestamptz
);
CREATE INDEX IF NOT EXISTS callbacks_open_idx ON callbacks (restaurant_id, handled_at, created_at DESC);

-- Ora stimata di pronto e conferma inviata al cliente.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS notified_at timestamptz;

-- Orari di partenza per la pizzeria demo: martedì-domenica, lunedì chiuso.
INSERT INTO restaurant_hours (id, restaurant_id, weekday, opens, closes)
SELECT ('30000000-0000-4000-8000-' || lpad(d.weekday::text, 12, '0'))::uuid,
       '00000000-0000-4000-8000-000000000001', d.weekday, '17:00', '22:30'
FROM (VALUES (0), (2), (3), (4), (5), (6)) AS d(weekday)
ON CONFLICT (id) DO NOTHING;

UPDATE menu_items SET category = 'classiche'
WHERE restaurant_id = '00000000-0000-4000-8000-000000000001' AND category IS NULL;
