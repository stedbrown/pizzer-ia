INSERT INTO restaurants (id, name, did_e164)
VALUES ('00000000-0000-4000-8000-000000000001', 'Pizzer-IA Demo', '+41912102049')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, did_e164 = EXCLUDED.did_e164;

INSERT INTO menu_items (id, restaurant_id, name, price_cents) VALUES
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Margherita', 1400),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Prosciutto', 1600),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'Diavola', 1700),
  ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'Quattro Formaggi', 1800),
  ('10000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 'Prosciutto e Funghi', 1800)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, price_cents = EXCLUDED.price_cents;

INSERT INTO menu_modifiers (id, restaurant_id, menu_item_id, name, price_cents)
SELECT ('20000000-0000-4000-8000-' || lpad(((i.n - 1) * 4 + m.n)::text, 12, '0'))::uuid,
       '00000000-0000-4000-8000-000000000001', i.id,
       m.name, m.price_cents
FROM (VALUES
  ('10000000-0000-4000-8000-000000000001'::uuid, 1),
  ('10000000-0000-4000-8000-000000000002'::uuid, 2),
  ('10000000-0000-4000-8000-000000000003'::uuid, 3),
  ('10000000-0000-4000-8000-000000000004'::uuid, 4),
  ('10000000-0000-4000-8000-000000000005'::uuid, 5)
) AS i(id, n)
CROSS JOIN (VALUES
  ('mozzarella extra', 200, 1),
  ('prosciutto extra', 300, 2),
  ('funghi extra', 200, 3),
  ('senza mozzarella', 0, 4)
) AS m(name, price_cents, n)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, price_cents = EXCLUDED.price_cents;
