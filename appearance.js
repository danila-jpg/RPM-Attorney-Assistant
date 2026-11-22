import { validateAppearance } from "./public/theme-catalog.js";

export const appearanceRevision = "md5(jsonb_build_array(id, theme, appearance_preferences)::text)";

export async function saveAppearance(pool, userId, body, res) {
  if (!res.req.is("application/json") || res.req.get("Sec-Fetch-Site") === "cross-site") {
    return res.status(403).json({ error: "Недопустимый запрос." });
  }
  const appearance = validateAppearance(body);
  if (!appearance) return res.status(400).json({ error: "Проверьте настройки оформления." });
  const previous = res.req.get("If-Match");
  if (previous !== undefined && !/^"[0-9a-f]{32}"$/.test(previous)) {
    return res.status(400).json({ error: "Некорректная версия оформления." });
  }
  const { rows } = await pool.query(
    `UPDATE rpm_users SET theme=$2, appearance_preferences=$3 WHERE id=$1 AND status='active'
     AND ($4::text IS NULL OR ${appearanceRevision}=$4)
     RETURNING theme, appearance_preferences AS preferences, ${appearanceRevision} AS appearance_revision`,
    [userId, appearance.theme, appearance.preferences, previous?.slice(1, -1)]
  );
  if (!rows.length) return previous ? res.status(409).json({ error: "Оформление уже изменено." }) :
    res.status(404).json({ error: "Профиль не найден." });
  const { appearance_revision: revision, ...saved } = rows[0];
  return res.set({ "Cache-Control": "no-store", ETag: '"' + revision + '"' }).json({ success: true, appearance: saved });
}
