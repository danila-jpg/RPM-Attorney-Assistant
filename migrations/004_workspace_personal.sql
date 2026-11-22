BEGIN;

CREATE TABLE IF NOT EXISTS rpm_workspace_favorites (
  user_id BIGINT NOT NULL REFERENCES rpm_users(id),
  category TEXT NOT NULL CHECK (category IN ('law', 'charter', 'document', 'case', 'question')),
  target TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category, target)
);

CREATE TABLE IF NOT EXISTS rpm_workspace_notification_reads (
  user_id BIGINT NOT NULL REFERENCES rpm_users(id),
  notification_id TEXT NOT NULL,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notification_id)
);

CREATE TABLE IF NOT EXISTS rpm_workspace_events (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES rpm_users(id),
  title TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS rpm_workspace_events_user_idx ON rpm_workspace_events(user_id, starts_at);

CREATE TABLE IF NOT EXISTS rpm_workspace_announcements (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
