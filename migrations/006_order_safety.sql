-- Le impostazioni seed non diventano fatti comunicabili finché il ristorante non le conferma dalla dashboard.
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS service_configured boolean NOT NULL DEFAULT false;

-- Una chiamata può produrre al massimo un ordine, anche con richieste concorrenti o più istanze applicative.
CREATE UNIQUE INDEX IF NOT EXISTS orders_call_id_unique_idx
  ON orders (call_id)
  WHERE call_id IS NOT NULL;
