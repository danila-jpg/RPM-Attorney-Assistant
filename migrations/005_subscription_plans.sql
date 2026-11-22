BEGIN;

CREATE TABLE IF NOT EXISTS rpm_subscription_plans (
  code TEXT PRIMARY KEY,
  duration_days INTEGER NOT NULL CHECK (duration_days BETWEEN 1 AND 3650),
  amount INTEGER NOT NULL CHECK (amount > 0),
  sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 0 AND 100000),
  active BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO rpm_subscription_plans (code, duration_days, amount, sort_order) VALUES
  ('1_days', 1, 60000, 10),
  ('3_days', 3, 150000, 20),
  ('7_days', 7, 300000, 30),
  ('14_days', 14, 750000, 40),
  ('30_days', 30, 2000000, 50),
  ('60_days', 60, 3600000, 60),
  ('90_days', 90, 5000000, 70),
  ('180_days', 180, 9000000, 80)
ON CONFLICT (code) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'rpm_orders'::regclass AND conname = 'rpm_orders_plan_code_check') THEN
    ALTER TABLE rpm_orders DROP CONSTRAINT rpm_orders_plan_code_check,
      DROP CONSTRAINT rpm_orders_duration_days_check,
      ADD CONSTRAINT rpm_orders_catalog_plan_fk FOREIGN KEY (plan_code) REFERENCES rpm_subscription_plans(code) NOT VALID,
      ADD CONSTRAINT rpm_orders_subscription_duration_check CHECK (duration_days BETWEEN 1 AND 3650) NOT VALID;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'rpm_licenses'::regclass AND conname = 'rpm_licenses_plan_code_check') THEN
    ALTER TABLE rpm_licenses DROP CONSTRAINT rpm_licenses_plan_code_check,
      ADD CONSTRAINT rpm_licenses_catalog_plan_fk FOREIGN KEY (plan_code) REFERENCES rpm_subscription_plans(code) NOT VALID;
  END IF;
END
$$;

COMMIT;
