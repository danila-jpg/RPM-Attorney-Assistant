BEGIN;
ALTER TABLE rpm_users ADD COLUMN IF NOT EXISTS help_offer_on_first_visit boolean NOT NULL DEFAULT false;
ALTER TABLE rpm_users ALTER COLUMN help_offer_on_first_visit SET DEFAULT true;
CREATE TABLE IF NOT EXISTS rpm_help_tour (
  user_id bigint PRIMARY KEY REFERENCES rpm_users(id) ON DELETE CASCADE,
  step smallint NOT NULL CHECK (step >= 0),
  status text NOT NULL CHECK (status IN ('active','skipped','completed'))
);
CREATE TABLE IF NOT EXISTS rpm_help_votes (
  user_id bigint REFERENCES rpm_users(id) ON DELETE CASCADE,
  article text NOT NULL,
  helpful boolean NOT NULL,
  PRIMARY KEY (user_id, article)
);
CREATE TABLE IF NOT EXISTS rpm_help_search_counts (
  topic text PRIMARY KEY,
  total bigint NOT NULL DEFAULT 0
);
COMMIT;
