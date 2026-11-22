BEGIN;

ALTER TABLE rpm_workspace_events
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'personal'
    CHECK (category IN ('court', 'meeting', 'consultation', 'deadline', 'personal')),
  ADD COLUMN IF NOT EXISTS case_id text;

CREATE TABLE IF NOT EXISTS rpm_workspace_exports (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES rpm_users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('analysis', 'police', 'case', 'archive')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rpm_workspace_exports_user_idx ON rpm_workspace_exports(user_id, created_at DESC);

COMMIT;
