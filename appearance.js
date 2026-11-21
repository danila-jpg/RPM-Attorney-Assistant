import { validateAppearance } from "./public/theme-catalog.js";

export async function saveAppearance(pool, userId, body, res) {
  if (!res.req.is("application/json") || res.req.get("Sec-Fetch-Site") === "cross-site") {
    return res.status(403).json({ error: "Недопустимый запрос." });
  }
  const appearance = validateAppearance(body);
  if (!appearance) return res.status(400).json({ error: "Проверьте настройки оформления." });
  const { rows } = await pool.query(
    "UPDATE rpm_users SET theme=$2, appearance_preferences=$3 WHERE id=$1 AND status='active' RETURNING theme, appearance_preferences AS preferences",
    [userId, appearance.theme, appearance.preferences]
  );
  if (!rows.length) return res.status(404).json({ error: "Профиль не найден." });
  return res.set("Cache-Control", "no-store").json({ success: true, appearance: rows[0] });
}
