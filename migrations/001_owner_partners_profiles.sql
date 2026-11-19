-- RPM Attorney Assistant: partner payouts, profile settings and themes.
-- Run once in the Neon SQL Editor before deploying this application version.

ALTER TABLE rpm_partners
  ADD COLUMN IF NOT EXISTS bank_account TEXT NOT NULL DEFAULT '';


ALTER TABLE rpm_users
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS avatar_data TEXT,
  ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'quantum-purple';

CREATE TABLE IF NOT EXISTS rpm_partner_payouts (
  id BIGSERIAL PRIMARY KEY,
  partner_id BIGINT NOT NULL REFERENCES rpm_partners(id),
  amount BIGINT NOT NULL CHECK (amount > 0),
  bank_account TEXT NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT,
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS rpm_partner_payouts_partner_paid_idx
  ON rpm_partner_payouts (partner_id, paid_at DESC);

CREATE INDEX IF NOT EXISTS rpm_commissions_partner_status_idx
  ON rpm_commissions (partner_id, status);

CREATE TABLE IF NOT EXISTS rpm_owner_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rpm_owner_audit_logs_created_idx
  ON rpm_owner_audit_logs (created_at DESC);
