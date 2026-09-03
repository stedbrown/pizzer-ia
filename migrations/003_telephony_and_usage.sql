ALTER TABLE calls ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ended_at timestamptz;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS duration_seconds integer CHECK (duration_seconds >= 0);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS audio_input_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS audio_output_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS text_input_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS text_output_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS openai_cost_usd_micros bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS telephony_status (
  restaurant_id uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  asterisk_online boolean NOT NULL DEFAULT false,
  sip_registration text NOT NULL DEFAULT 'unknown' CHECK (sip_registration IN ('registered','unregistered','unknown')),
  asterisk_version text,
  checked_at timestamptz NOT NULL DEFAULT '1970-01-01',
  inbound_status text NOT NULL DEFAULT 'waiting' CHECK (inbound_status IN ('waiting','ok','error')),
  audio_status text NOT NULL DEFAULT 'waiting' CHECK (audio_status IN ('waiting','ok','error')),
  openai_realtime text NOT NULL DEFAULT 'waiting' CHECK (openai_realtime IN ('waiting','ready','connected','error')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO telephony_status (restaurant_id)
SELECT id FROM restaurants
ON CONFLICT (restaurant_id) DO NOTHING;
