import { isTheme } from "./public/theme-catalog.js";
import { saveAppearance } from "./appearance.js";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { citation, documentDisplayText, documentEntries, resolveNorm, searchableEntries } from "./documents.js";
import { gradeQuestion, makeQuestions, summarizeTraining } from "./training.js";
import { destroyLoginSession, recordAdminAuth } from "./customer-auth-routes.js";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const profileFields = "username, rp_nickname, COALESCE(display_name,rp_nickname) AS display_name, avatar_data, COALESCE(theme,'quantum-purple') AS theme, appearance_preferences AS preferences";
function validAvatar(value) {
  if (typeof value !== "string" || value.length > 670_000) return false;
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([a-z0-9+/]+={0,2})$/i);
  if (!match) return false;
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 500_000) return false;
  switch (match[1].toLowerCase()) {
    case "png": return bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
    case "jpeg": return bytes.subarray(0, 3).toString("hex") === "ffd8ff";
    case "webp": return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  }
}
const metadata = ({ id, name, type, organization, revision, status, addedAt, source, archivedAt }) =>
  ({ id, name, type: type || "law", organization, revision, status, addedAt, source, archivedAt });

function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error("Workspace request failed", req.route.path, error.code || error.name);
      if (req.route.path.startsWith("/api/training/") && ["42P01", "42703"].includes(error.code)) {
        return res.status(503).json({ error: "Хранилище учебного прогресса не готово. Администратору базы нужно проверить миграцию 002_workspace.sql." });
      }
      if (req.route.path.startsWith("/api/admin/self") && error.code === "42P01") {
        return res.status(503).json({ error: "Хранилище кабинета не готово. Администратору базы нужно проверить миграцию 002_workspace.sql." });
      }
      res.status(500).json({ error: "Не удалось выполнить запрос. Попробуйте позже." });
    }
  };
}

export default function registerWorkspace(app, { pool, requireAdmin, loadLaws, getDocuments, sendWorkspace }) {
  const requireSession = (req, res, next) => {
    if (req.adminSessionVerified) return next();
    return res.status(401).json({ error: "Войдите через /admin-login для управления сессиями и паролем." });
  };
  const audit = (userId, action, result, db = pool) => db.query(
    "INSERT INTO rpm_admin_activity (user_id, action, result) VALUES ($1, $2, $3)", [userId, action, result]);
  const requireWorkspaceSession = (req, res, next) => {
    if (req.adminSessionVerified || req.isCustomer) return next();
    res.status(401).json({ error: "Для доступа войдите в аккаунт через форму входа." });
  };
  app.use(["/api/documents", "/api/training"], requireWorkspaceSession);

  app.get("/admin", requireAdmin, requireSession, sendWorkspace);
  app.get(["/charters", "/training"], sendWorkspace);

  app.get("/api/documents", route(async (req, res) => {
    res.json(getDocuments(await loadLaws()).map(metadata));
  }));
  app.get("/api/documents/resolve", route(async (req, res) => {
    const laws = await loadLaws();
    const result = resolveNorm([...getDocuments(laws), ...(laws.archivedDocuments || [])], String(req.query.q || "").slice(0, 800));
    res.json({ ...result, message: {
      missing: "Норма с указанными реквизитами не найдена.",
      ambiguous: "Найдено несколько норм. Уточните главу, раздел, статью или редакцию.",
      confirmed: "Норма подтверждена."
    }[result.status] });
  }));
  app.get("/api/documents/:id", route(async (req, res) => {
    const laws = await loadLaws();
    const archive = laws.archivedDocuments || [];
    const doc = [...getDocuments(laws), ...archive].find(item => item.id === req.params.id);
    if (!doc) return res.status(404).json({ error: "Документ не найден." });
    res.json({
      ...metadata(doc), fullText: documentDisplayText(doc),
      structure: documentEntries(doc).filter(entry => Number.isInteger(entry.line)), history: archive.filter(item => item.documentId === (doc.documentId || doc.id)).map(metadata)
    });
  }));

  app.get("/api/admin/self", requireSession, route(async (req, res) => {
    const [profile, history, stats] = await Promise.allSettled([
      pool.query(`SELECT ${profileFields} FROM rpm_users WHERE id=$1 AND role='admin' AND status='active'`, [req.userId]),
      pool.query("SELECT action, result, created_at FROM rpm_admin_activity WHERE user_id=$1 ORDER BY id DESC LIMIT 50", [req.userId]),
      pool.query(`SELECT (SELECT count(*) FROM rpm_cases WHERE user_id=$1)::int AS cases,
        (SELECT count(*) FROM rpm_training_attempts WHERE user_id=$1 AND completed_at IS NOT NULL)::int AS training`, [req.userId])
    ]);
    if (profile.status === "rejected") throw profile.reason;
    if (!profile.value.rowCount) return res.status(404).json({ error: "Профиль не найден." });
    res.set("Cache-Control", "no-store").json({ profile: profile.value.rows[0],
      history: history.value?.rows ?? null, stats: stats.value?.rows[0] ?? null });
  }));
  app.patch("/api/admin/self/profile", requireSession, route((req, res) =>
    saveAppearance(pool, req.userId, req.body, res)));
  app.put("/api/admin/self/profile", requireSession, route(async (req, res) => {
    const { rp_nickname: rp, display_name: name, avatar_data: avatar, theme } = req.body || {};
    if ([rp, name].some(value => typeof value !== "string" || !value.trim() || value.length > 64) ||
        (theme !== undefined && !isTheme(theme)) ||
        (avatar != null && !validAvatar(avatar))) {
      return res.status(400).json({ error: "Проверьте имена, тему и формат аватара." });
    }
    const result = await pool.query(`WITH updated AS (
      UPDATE rpm_users SET rp_nickname=$2, display_name=$3, avatar_data=CASE WHEN $4 THEN $5 ELSE avatar_data END, theme=COALESCE($6, theme)
      WHERE id=$1 AND role='admin' AND status='active' RETURNING id, ${profileFields}
    ), logged AS (
      INSERT INTO rpm_admin_activity (user_id, action, result) SELECT id, 'Профиль', 'Сохранён' FROM updated
    ) SELECT username, rp_nickname, display_name, avatar_data, theme, preferences FROM updated`,
    [req.userId, rp.trim(), name.trim(), avatar !== undefined, avatar ?? null, theme ?? null]);
    if (!result.rowCount) return res.status(404).json({ error: "Профиль не найден." });
    res.json({ success: true, profile: result.rows[0] });
  }));
  app.post("/api/admin/self/logout", requireSession, route(async (req, res) => {
    await destroyLoginSession(req, res, { clearDevice: false });
    await recordAdminAuth(pool, req.userId, "Выход");
    res.json({ success: true });
  }));
  app.post("/api/admin/self/password", requireSession, route(async (req, res) => {
    const { current, password, confirmation } = req.body || {};
    if (typeof current !== "string" || Buffer.byteLength(current) > 72 || typeof password !== "string" ||
        password.length < 12 || Buffer.byteLength(password) > 72 || password !== confirmation) {
      return res.status(400).json({ error: "Пароль должен содержать от 12 символов и до 72 байт. Проверьте подтверждение." });
    }
    const user = (await pool.query("SELECT password_hash FROM rpm_users WHERE id=$1", [req.userId])).rows[0];
    if (!user || !(await bcrypt.compare(current, user.password_hash))) {
      await audit(req.userId, "Смена пароля", "Отклонена");
      return res.status(400).json({ error: "Текущий пароль указан неверно." });
    }
    const updated = await pool.query(`WITH updated AS (
      UPDATE rpm_users SET password_hash=$2 WHERE id=$1 AND password_hash=$3 AND role='admin' AND status='active' RETURNING id
    ) INSERT INTO rpm_admin_activity (user_id, action, result) SELECT id, 'Смена пароля', 'Выполнена' FROM updated`,
    [req.userId, await bcrypt.hash(password, 12), user.password_hash]);
    if (!updated.rowCount) return res.status(409).json({ error: "Пароль уже был изменён. Повторите вход." });
    res.json({ success: true });
  }));
  app.get("/api/admin/self/sessions", requireSession, route(async (req, res) => {
    const result = await pool.query(`SELECT d.device_name, d.last_seen_at, s.expire, s.sid=$2 AS current,
      md5(s.sid) AS id FROM rpm_sessions s JOIN rpm_devices d ON d.id::text=s.sess->>'deviceId'
      WHERE s.sess->>'userId'=$1 AND d.user_id=$1::bigint AND d.revoked_at IS NULL AND s.expire>now()
      ORDER BY d.last_seen_at DESC`, [String(req.userId), req.sessionID]);
    res.json(result.rows);
  }));
  app.get("/api/admin/self/devices", requireSession, route(async (req, res) => {
    const result = await pool.query(`SELECT id, device_name, last_seen_at, id::text=$2 AS current
      FROM rpm_devices WHERE user_id=$1 AND revoked_at IS NULL ORDER BY last_seen_at DESC`,
    [req.userId, req.session.deviceId]);
    res.json(result.rows);
  }));
  app.delete("/api/admin/self/devices/:id", requireSession, route(async (req, res) => {
    const { id } = req.params;
    if (!/^[a-z0-9-]{1,64}$/i.test(id) || id === req.session.deviceId) {
      return res.status(400).json({ error: "Для текущего устройства используйте выход из аккаунта." });
    }
    const result = await pool.query(`WITH revoked AS (
      UPDATE rpm_devices SET revoked_at=now() WHERE id::text=$2 AND user_id=$1 AND revoked_at IS NULL RETURNING id
    ), removed AS (
      DELETE FROM rpm_sessions WHERE sess->>'userId'=$1::bigint::text AND sess->>'deviceId' IN (SELECT id::text FROM revoked)
    ) INSERT INTO rpm_admin_activity (user_id, action, result) SELECT $1, 'Устройство', 'Отключено' FROM revoked`,
    [req.userId, id]);
    res.json({ success: true, revoked: result.rowCount > 0 });
  }));
  app.delete("/api/admin/self/sessions/:id", requireSession, route(async (req, res) => {
    const { id } = req.params;
    if (id !== "others" && !/^[a-f0-9]{32}$/.test(id)) return res.status(400).json({ error: "Сессия не найдена." });
    const result = await pool.query(`WITH removed AS (
      DELETE FROM rpm_sessions WHERE sess->>'userId'=$1 AND sid<>$2 AND ($3='others' OR md5(sid)=$3) RETURNING sid
    ) INSERT INTO rpm_admin_activity (user_id, action, result)
      SELECT $1::bigint, 'Завершение сессий', 'Завершены' WHERE EXISTS (SELECT 1 FROM removed)`, [String(req.userId), req.sessionID, id]);
    res.json({ success: true, revoked: result.rowCount > 0 });
  }));

  app.get("/api/training/progress", route(async (req, res) => {
    const result = await pool.query("SELECT mode, questions, answers, completed_at FROM rpm_training_attempts WHERE user_id=$1", [req.userId]);
    res.json(summarizeTraining(result.rows));
  }));
  async function startAttempt(req, res, mode, questions) {
    const id = randomUUID();
    await pool.query("INSERT INTO rpm_training_attempts (id, user_id, mode, questions) VALUES ($1,$2,$3,$4::jsonb)",
      [id, req.userId, mode, JSON.stringify(questions)]);
    res.json({ id, questions: questions.map(({ correct, text, reference, anchor, explanation, ...question }) =>
      mode === "cards" ? { ...question, text, reference, anchor } : question) });
  }

  app.post("/api/training/attempts", route(async (req, res) => {
    const { mode, size, documentIds } = req.body || {};
    if (!["cards", "quiz", "practice", "exam"].includes(mode) || ![5, 10, 20].includes(size) ||
        !Array.isArray(documentIds) || !documentIds.length || documentIds.length > 50 ||
        documentIds.some(id => typeof id !== "string" || id.length > 100)) {
      return res.status(400).json({ error: "Выберите документы, режим и размер." });
    }
    const docs = getDocuments(await loadLaws()).filter(doc => documentIds.includes(doc.id));
    const questions = makeQuestions(docs, mode, size).filter(question => mode === "cards" || question.choices.length >= 2);
    if (!questions.length || (["quiz", "exam"].includes(mode) && questions.length !== size)) {
      return res.status(422).json({ error: "Для выбранного размера недостаточно однозначных вопросов. Выберите больше документов или меньший размер." });
    }
    await startAttempt(req, res, mode, questions);
  }));
  app.post("/api/training/attempts/:id/retry", route(async (req, res) => {
    if (!uuid.test(req.params.id)) return res.status(404).json({ error: "Занятие не найдено." });
    const { rows } = await pool.query(
      "SELECT mode, questions, answers FROM rpm_training_attempts WHERE id=$1 AND user_id=$2 AND completed_at IS NOT NULL",
      [req.params.id, req.userId]
    );
    if (!rows.length) return res.status(404).json({ error: "Завершённое занятие не найдено." });
    const attempt = rows[0];
    const referencedIds = new Set(attempt.questions.map(question => question.documentId));
    const current = new Map(getDocuments(await loadLaws()).filter(doc => referencedIds.has(doc.id)).map(doc =>
      [doc.id, new Map(searchableEntries(doc).map(entry => [citation(doc, entry), entry]))]));
    const questions = attempt.questions.filter((question, index) => {
      if (attempt.answers[index]?.correct) return false;
      const entry = current.get(question.documentId)?.get(question.reference);
      return entry?.text === question.text && entry.id === question.anchor;
    });
    if (!questions.length) return res.status(422).json({ error: "Нет ошибок по действующим документам." });
    await startAttempt(req, res, attempt.mode, questions);
  }));
  app.post("/api/training/attempts/:id/answers", route(async (req, res) => {
    const { index, answer } = req.body || {};
    if (!uuid.test(req.params.id) || !Number.isInteger(index) || index < 0) return res.status(400).json({ error: "Некорректный вопрос." });
    const params = [req.params.id, req.userId];
    const attempt = (await pool.query("SELECT mode, questions, answers FROM rpm_training_attempts WHERE id=$1 AND user_id=$2", params)).rows[0];
    const question = attempt?.questions[index];
    if (!question) return res.status(404).json({ error: "Вопрос не найден." });
    const correct = gradeQuestion(question, attempt.mode, answer);
    if (correct === null) return res.status(400).json({ error: "Выберите ответ." });
    const stored = { answer, correct, at: new Date().toISOString() };
    const updated = await pool.query(`UPDATE rpm_training_attempts SET answers=answers || jsonb_build_object($3::text,$4::jsonb),
      completed_at=CASE WHEN (SELECT count(*) FROM jsonb_object_keys(answers))+1=jsonb_array_length(questions) THEN now() ELSE completed_at END
      WHERE id=$1 AND user_id=$2 AND NOT jsonb_exists(answers,$3::text) RETURNING answers, completed_at`,
    [...params, String(index), JSON.stringify(stored)]);
    const state = updated.rows[0] || (await pool.query("SELECT answers, completed_at FROM rpm_training_attempts WHERE id=$1 AND user_id=$2", params)).rows[0];
    const wrong = state.completed_at ? attempt.questions.filter((_, position) => !state.answers[position]?.correct)
      .map(({ reference, documentId, anchor }) => ({ reference, documentId, anchor })) : [];
    res.json({
      correct: state.answers[index].correct, selected: state.answers[index].answer,
      text: question.text, reference: question.reference, documentId: question.documentId, anchor: question.anchor, explanation: question.explanation,
      result: state.completed_at ? { percent: Math.round((attempt.questions.length - wrong.length) * 100 / attempt.questions.length), wrong } : null
    });
  }));
}
