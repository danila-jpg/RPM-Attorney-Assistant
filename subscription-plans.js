import { randomUUID } from "node:crypto";

const fields = "code, duration_days, amount, sort_order, active";
const planNames = new Map([
  ["1_days", "Пробный"], ["3_days", "Старт"], ["7_days", "Недельный"], ["14_days", "Стандарт"],
  ["30_days", "Месячный"], ["60_days", "Премиум"], ["90_days", "Квартальный"], ["180_days", "Полугодовой"]
]);

export function normalizePlanCode(value) {
  const code = typeof value === "string" ? value.trim() : "";
  return code === "1_day" ? "1_days" : code;
}

function planValues(body) {
  if (!body) return null;
  const { duration_days, amount, sort_order, active } = body;
  if (!Number.isInteger(duration_days) || duration_days < 1 || duration_days > 3650 ||
      !Number.isInteger(amount) || amount < 1 || amount > 2147483647 ||
      !Number.isInteger(sort_order) || sort_order < 0 || sort_order > 100000 || typeof active !== "boolean") return null;
  return [duration_days, amount, sort_order, active];
}

export function registerSubscriptionCatalog(app, pool) {
  app.get("/api/subscription-plans", async (req, res, next) => {
    try {
      const { rows } = await pool.query(`SELECT ${fields} FROM rpm_subscription_plans
        WHERE active ORDER BY sort_order, duration_days, code`);
      const plans = rows.map(plan => ({ ...plan, name: planNames.get(plan.code) || null }));
      res.set("Cache-Control", "no-store").json({ success: true, plans });
    } catch (error) { next(error); }
  });
}

export function registerPlanManagement(app, pool, requireOwner) {
  const path = "/api/owner/subscription-plans";
  app.get(path, requireOwner, async (req, res, next) => {
    try {
      const { rows } = await pool.query(`SELECT ${fields} FROM rpm_subscription_plans ORDER BY sort_order, duration_days, code`);
      res.set("Cache-Control", "no-store").json({ success: true, plans: rows });
    } catch (error) { next(error); }
  });

  function save(create) {
    return async (req, res, next) => {
      const values = planValues(req.body);
      if (!req.is("application/json") || req.get("Sec-Fetch-Site") === "cross-site" || !values) {
        return res.status(400).json({ success: false, error: "Укажите допустимые срок, цену и порядок." });
      }
      try {
        const code = create ? "plan_" + randomUUID().replaceAll("-", "").slice(0, 12) : req.params.code;
        const { rows: [plan] } = create
          ? await pool.query(`INSERT INTO rpm_subscription_plans (${fields}) VALUES ($1,$2,$3,$4,$5) RETURNING ${fields}`, [code, ...values])
          : await pool.query(`UPDATE rpm_subscription_plans SET duration_days=$2, amount=$3, sort_order=$4, active=$5
            WHERE code=$1 RETURNING ${fields}`, [code, ...values]);
        if (!plan) return res.status(404).json({ success: false, error: "Тариф не найден." });
        res.status(create ? 201 : 200).json({ success: true, plan });
      } catch (error) { next(error); }
    };
  }
  app.post(path, requireOwner, save(true));
  app.patch(path + "/:code", requireOwner, save(false));
}
