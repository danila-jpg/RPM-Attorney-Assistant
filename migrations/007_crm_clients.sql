BEGIN;

CREATE TABLE IF NOT EXISTS rpm_crm_clients (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES rpm_users(id),
  rp_name TEXT NOT NULL CHECK (char_length(rp_name) BETWEEN 1 AND 120),
  contact TEXT NOT NULL DEFAULT '',
  organization TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS rpm_crm_clients_owner_archive_idx
  ON rpm_crm_clients(user_id, (archived_at IS NOT NULL), updated_at DESC, id);

COMMIT;
