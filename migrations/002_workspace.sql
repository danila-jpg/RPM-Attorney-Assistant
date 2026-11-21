BEGIN;

CREATE TABLE IF NOT EXISTS rpm_admin_activity (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES rpm_users(id),
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rpm_admin_activity_user_idx ON rpm_admin_activity (user_id, id DESC);

CREATE TABLE IF NOT EXISTS rpm_training_attempts (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES rpm_users(id),
  mode TEXT NOT NULL CHECK (mode IN ('cards', 'quiz', 'practice', 'exam')),
  questions JSONB NOT NULL,
  answers JSONB NOT NULL DEFAULT '{}',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rpm_training_attempts_user_idx ON rpm_training_attempts (user_id, created_at DESC);

COMMIT;
