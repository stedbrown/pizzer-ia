ALTER TABLE telephony_status ADD COLUMN IF NOT EXISTS test_mode_until timestamptz;

CREATE TABLE IF NOT EXISTS live_log_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  level text NOT NULL CHECK (level IN ('DEBUG','INFO','WARN','ERROR')),
  category text NOT NULL CHECK (category IN ('TELEPHONY','OPENAI','BACKEND','TOOL','DATABASE')),
  message text NOT NULL CHECK (char_length(message) <= 500),
  call_id text
);

CREATE INDEX IF NOT EXISTS live_log_events_restaurant_id_idx
  ON live_log_events (restaurant_id, id DESC);
