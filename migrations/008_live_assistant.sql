BEGIN;

CREATE TABLE IF NOT EXISTS rpm_live_metrics (
  day date NOT NULL,
  event text NOT NULL,
  mode text NOT NULL,
  count bigint NOT NULL DEFAULT 0,
  duration_ms bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event, mode)
);

CREATE TABLE IF NOT EXISTS rpm_live_phrases (
  user_id bigint NOT NULL REFERENCES rpm_users(id) ON DELETE CASCADE,
  slot smallint NOT NULL CHECK (slot BETWEEN 0 AND 6),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500),
  PRIMARY KEY (user_id, slot)
);

COMMIT;
