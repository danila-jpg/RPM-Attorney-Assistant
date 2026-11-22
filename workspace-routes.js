import { isTheme } from "./public/theme-catalog.js";
import { appearanceRevision, saveAppearance } from "./appearance.js";
import { randomUUID } from "node:crypto";
import { requestLimit } from "./request-limits.js";
import bcrypt from "bcryptjs";
import { citation, documentDisplayText, documentEntries, resolveNorm, searchableEntries } from "./documents.js";
import { gradeQuestion, makeQuestions, summarizeTraining, validateQuestion } from "./training.js";
import { destroyLoginSession, recordAdminAuth } from "./customer-auth-routes.js";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const profileFields = `username, rp_nickname, COALESCE(display_name,rp_nickname) AS display_name, avatar_data,
  COALESCE(theme,'quantum-purple') AS theme, appearance_preferences AS preferences, ${appearanceRevision} AS appearance_revision`;
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
      if (req.route.path.startsWith("/api/workspace/") && error.code === "42P01") {
        return res.status(503).json({ error: "Хранилище рабочего пространства недоступно. Проверьте миграцию 004_workspace_personal.sql." });
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
  app.use(["/api/documents", "/api/training", "/api/workspace"], requireWorkspaceSession);

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


  const documentLink = (id, anchor) => "/charters?doc=" + encodeURIComponent(id) + (anchor ? "#" + encodeURIComponent(anchor) : "");
  const normResult = (doc, entry) => ({
    category: entry ? (doc.type === "law" ? "law" : "charter") : "document",
    target: entry ? doc.id + ":" + entry.id : doc.id,
    title: entry ? citation(doc, entry) : doc.name,
    href: documentLink(doc.id, entry?.id)
  });
  const caseResult = record => ({ category: "case", target: String(record.id), title: record.title,
    href: "/?tab=history&case=" + encodeURIComponent(record.id) });
  const questionResult = (attempt, index) => ({ category: "question", target: attempt.id + ":" + index,
    title: attempt.questions[index].prompt, href: "/training?review=" + attempt.id + "#" + index });
  const ownedCases = (userId, search = "") => pool.query(
    "SELECT id, title FROM rpm_cases WHERE user_id=$1 AND ($2='' OR strpos(lower(title || ' ' || data::text), $2)>0) ORDER BY updated_at DESC LIMIT 15",
    [userId, search]);
  const completed = userId => pool.query(
    "SELECT id, mode, questions, answers, completed_at FROM rpm_training_attempts WHERE user_id=$1 AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 30",
    [userId]);

  app.get("/api/workspace/search", route(async (req, res) => {
    const term = String(req.query.q || "").trim().toLowerCase().slice(0, 120);
    if (term.length < 2) return res.json([]);
    const [laws, cases, attempts] = await Promise.all([loadLaws(), ownedCases(req.userId, term), completed(req.userId)]);
    const documents = getDocuments(laws);
    const includes = value => String(value || "").toLowerCase().includes(term);
    const catalog = documents.filter(doc => includes(doc.name) || includes(doc.organization)).map(doc => normResult(doc));
    const provisions = documents.flatMap(doc => searchableEntries(doc).filter(entry =>
      entry.id && (includes(citation(doc, entry)) || includes(entry.text))).slice(0, 4).map(entry => normResult(doc, entry)));
    const materials = attempts.rows.flatMap(attempt => attempt.questions.flatMap((question, index) =>
      includes(question.prompt) ? [questionResult(attempt, index)] : [])).slice(0, 8);
    res.set("Cache-Control", "no-store").json([...catalog.slice(0, 12), ...cases.rows.map(caseResult), ...materials, ...provisions.slice(0, 20)]);
  }));

  async function resolveFavorite(userId, category, target, documents) {
    if (category === "case") {
      const { rows: [record] } = await pool.query("SELECT id, title FROM rpm_cases WHERE user_id=$1 AND id::text=$2", [userId, target]);
      return record && caseResult(record);
    }
    if (category === "question") {
      const [id, index, extra] = target.split(":");
      if (!uuid.test(id) || !/^\d+$/.test(index || "") || extra !== undefined) return null;
      const { rows: [attempt] } = await pool.query("SELECT id, questions FROM rpm_training_attempts WHERE user_id=$1 AND id=$2 AND completed_at IS NOT NULL", [userId, id]);
      return attempt?.questions[index] && questionResult(attempt, Number(index));
    }
    if (!["law", "charter", "document"].includes(category)) return null;
    const [id, anchor, extra] = target.split(":");
    if (extra !== undefined) return null;
    const doc = documents.find(item => item.id === id);
    if (!doc) return null;
    if (category === "document") return anchor === undefined ? normResult(doc) : null;
    const entry = searchableEntries(doc).find(item => item.id === anchor);
    const result = entry && normResult(doc, entry);
    return result?.category === category ? result : null;
  }

  app.get("/api/workspace/favorites", route(async (req, res) => {
    const [laws, favorite] = await Promise.all([
      loadLaws(),
      pool.query("SELECT category,target FROM rpm_workspace_favorites WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100", [req.userId])
    ]);
    const documents = getDocuments(laws);
    const results = await Promise.all(favorite.rows.map(({ category, target }) => resolveFavorite(req.userId, category, target, documents)));
    res.set("Cache-Control", "no-store").json(results.filter(Boolean));
  }));
  app.put("/api/workspace/favorites", route(async (req, res) => {
    const { category, target, saved } = req.body || {};
    if (typeof category !== "string" || typeof target !== "string" || target.length > 160 || typeof saved !== "boolean") {
      return res.status(400).json({ error: "Проверьте параметры избранного." });
    }
    if (saved) {
      const result = await resolveFavorite(req.userId, category, target, getDocuments(await loadLaws()));
      if (!result) return res.status(404).json({ error: "Материал не найден." });
      await pool.query("INSERT INTO rpm_workspace_favorites(user_id,category,target) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [req.userId, category, target]);
    } else {
      await pool.query("DELETE FROM rpm_workspace_favorites WHERE user_id=$1 AND category=$2 AND target=$3", [req.userId, category, target]);
    }
    res.json({ saved });
  }));

  const upcomingEvents = userId => pool.query(`SELECT id,title,starts_at FROM rpm_workspace_events
    WHERE user_id=$1 AND starts_at>=now() ORDER BY starts_at LIMIT 30`, [userId]);
  app.get("/api/workspace/events", route(async (req, res) => {
    res.set("Cache-Control", "no-store").json((await upcomingEvents(req.userId)).rows);
  }));
  app.post("/api/workspace/events", route(async (req, res) => {
    const { title, startsAt } = req.body || {};
    const date = typeof startsAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(startsAt) ? new Date(startsAt) : null;
    if (typeof title !== "string" || !title.trim() || title.length > 120 || !date ||
        !Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Укажите название и время будущего события." });
    }
    const { rows: [event] } = await pool.query(`INSERT INTO rpm_workspace_events(id,user_id,title,starts_at)
      VALUES($1,$2,$3,$4) RETURNING id,title,starts_at`, [randomUUID(), req.userId, title.trim(), date]);
    res.status(201).json(event);
  }));
  app.delete("/api/workspace/events/:id", route(async (req, res) => {
    if (!uuid.test(req.params.id)) return res.status(404).json({ error: "Событие не найдено." });
    const result = await pool.query("DELETE FROM rpm_workspace_events WHERE id=$1 AND user_id=$2", [req.params.id, req.userId]);
    if (!result.rowCount) return res.status(404).json({ error: "Событие не найдено." });
    res.json({ removed: true });
  }));
  app.post("/api/workspace/announcements", route(async (req, res) => {
    if (!req.isOwner || !req.adminSessionVerified) return res.status(403).json({ error: "Доступно владельцу." });
    const { title } = req.body || {};
    if (typeof title !== "string" || !title.trim() || title.length > 240) return res.status(400).json({ error: "Введите сообщение." });
    await pool.query("INSERT INTO rpm_workspace_announcements(id,title) VALUES($1,$2)", [randomUUID(), title.trim()]);
    res.status(201).json({ published: true });
  }));

  async function personalOverview(userId) {
    const [profile, license, cases, attempts, events] = await Promise.all([
      pool.query("SELECT COALESCE(display_name, rp_nickname, username) AS name FROM rpm_users WHERE id=$1", [userId]),
      pool.query("SELECT expires_at FROM rpm_licenses WHERE user_id=$1 AND status='active' AND expires_at>now() ORDER BY expires_at DESC LIMIT 1", [userId]),
      ownedCases(userId), completed(userId), upcomingEvents(userId)
    ]);
    return { name: profile.rows[0]?.name, expires: license.rows[0]?.expires_at,
      cases: cases.rows.slice(0, 5).map(caseResult), attempts: attempts.rows, events: events.rows.slice(0, 5) };
  }
  app.get("/api/workspace/dashboard", route(async (req, res) => {
    const [{ attempts, ...overview }, laws] = await Promise.all([personalOverview(req.userId), loadLaws()]);
    const recentDocuments = getDocuments(laws).filter(doc => doc.addedAt)
      .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt)).slice(0, 5).map(doc => normResult(doc));
    res.set("Cache-Control", "no-store").json({ ...overview, progress: summarizeTraining(attempts), recentDocuments,
      canAnnounce: Boolean(req.isOwner && req.adminSessionVerified) });
  }));
  async function notifications(userId) {
    const [{ attempts, expires, events }, { rows: reads }, laws, { rows: announcements }] = await Promise.all([
      personalOverview(userId),
      pool.query("SELECT notification_id FROM rpm_workspace_notification_reads WHERE user_id=$1", [userId]),
      loadLaws(), pool.query("SELECT id,title FROM rpm_workspace_announcements WHERE published_at<=now() ORDER BY published_at DESC LIMIT 20")
    ]);
    const result = attempts.filter(item => item.mode === "exam").map(attempt => {
      const percent = Math.round(Object.values(attempt.answers).filter(item => item.correct).length * 100 / attempt.questions.length);
      return { id: "exam:" + attempt.id, title: "Результат экзамена — " + percent + "%", href: "/training?review=" + attempt.id };
    });
    if (expires && new Date(expires).getTime() - Date.now() <= 7 * 86_400_000) {
      result.unshift({ id: "subscription:" + new Date(expires).toISOString(), title: "Подписка действует до " +
        new Intl.DateTimeFormat("ru", { dateStyle: "long", timeZone: "Europe/Riga" }).format(new Date(expires)), href: "/app/account.html" });
    }
    const now = Date.now();
    const withinWeek = time => Number.isFinite(time) && Math.abs(time - now) <= 7 * 86_400_000;
    for (const event of events.filter(item => withinWeek(new Date(item.starts_at).getTime()))) {
      result.push({ id: "event:" + event.id, title: "Скоро · " + event.title, href: "/?tab=calendar" });
    }
    for (const doc of getDocuments(laws).filter(item => item.revision &&
        (laws.archivedDocuments || []).some(old => old.documentId === item.id) &&
        withinWeek(Date.parse(item.revision)) && Date.parse(item.revision) <= now)) {
      result.push({ id: "revision:" + doc.id + ":" + doc.revision, title: "Новая редакция · " + doc.name,
        href: documentLink(doc.id) });
    }
    for (const announcement of announcements) result.push({ id: "system:" + announcement.id, title: announcement.title });
    const seen = new Set(reads.map(item => item.notification_id));
    return result.map(item => ({ ...item, read: seen.has(item.id) }));
  }
  app.get("/api/workspace/notifications", route(async (req, res) => {
    res.set("Cache-Control", "no-store").json(await notifications(req.userId));
  }));
  app.post("/api/workspace/notifications/read", route(async (req, res) => {
    const { id } = req.body || {};
    if (typeof id !== "string" || !((await notifications(req.userId)).some(item => item.id === id))) {
      return res.status(404).json({ error: "Уведомление не найдено." });
    }
    await pool.query("INSERT INTO rpm_workspace_notification_reads(user_id,notification_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [req.userId, id]);
    res.json({ read: true });
  }));

  app.get("/api/training/progress", route(async (req, res) => {
    const result = await pool.query("SELECT id, mode, questions, answers, completed_at FROM rpm_training_attempts WHERE user_id=$1 ORDER BY created_at DESC", [req.userId]);
    res.json(summarizeTraining(result.rows));
  }));
  function publicQuestions(questions, mode) {
    return questions.map(({ text, reference, anchor, prompt, type, choices, documentId }) =>
      mode === "cards" ? { text, reference, anchor, prompt, type, choices, documentId } : { prompt, choices, type });
  }

  app.get("/api/training/attempts/current", route(async (req, res) => {
    const { rows: [attempt] } = await pool.query(`SELECT id, mode, questions, answers FROM rpm_training_attempts
      WHERE user_id=$1 AND completed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [req.userId]);
    if (!attempt || !attempt.questions.every(validateQuestion)) return res.json(null);
    res.set("Cache-Control", "no-store").json({ id: attempt.id, mode: attempt.mode,
      questions: publicQuestions(attempt.questions, attempt.mode),
      index: attempt.questions.findIndex((_, index) => !Object.hasOwn(attempt.answers, index)) });
  }));

  app.get("/api/training/attempts/:id/review", route(async (req, res) => {
    if (!uuid.test(req.params.id)) return res.status(404).json({ error: "Занятие не найдено." });
    const { rows: [attempt] } = await pool.query(`SELECT mode, questions, answers, completed_at FROM rpm_training_attempts
      WHERE id=$1 AND user_id=$2 AND completed_at IS NOT NULL`, [req.params.id, req.userId]);
    if (!attempt) return res.status(404).json({ error: "Занятие не найдено." });
    res.set("Cache-Control", "no-store").json(attempt);
  }));

  async function startAttempt(req, res, mode, questions) {
    const id = randomUUID();
    await pool.query("INSERT INTO rpm_training_attempts (id, user_id, mode, questions) VALUES ($1,$2,$3,$4::jsonb)",
      [id, req.userId, mode, JSON.stringify(questions)]);
    res.json({ id, mode, questions: publicQuestions(questions, mode) });
  }

  app.post("/api/training/attempts", requestLimit(15, 60000), route(async (req, res) => {
    const { mode, size, documentIds } = req.body || {};
    if (!["cards", "quiz", "practice", "exam"].includes(mode) || ![5, 10, 20].includes(size) ||
        !Array.isArray(documentIds) || !documentIds.length || documentIds.length > 50 ||
        documentIds.some(id => typeof id !== "string" || id.length > 100)) {
      return res.status(400).json({ error: "Выберите документы, режим и размер." });
    }
    const docs = getDocuments(await loadLaws()).filter(doc => documentIds.includes(doc.id));
    const questions = makeQuestions(docs, mode, size);
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
      return entry?.text === question.text && entry.id === question.anchor && validateQuestion(question);
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
    if (!question || !validateQuestion(question)) return res.status(404).json({ error: "Вопрос не найден." });
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
    const review = (item, position) => ({
      correct: state.answers[position].correct, selected: state.answers[position].answer, correctChoice: item.correct,
      text: item.text, reference: item.reference, revision: item.revision, source: item.source,
      documentId: item.documentId, anchor: item.anchor, explanation: item.explanation
    });
    const result = state.completed_at ? {
      percent: Math.round((attempt.questions.length - wrong.length) * 100 / attempt.questions.length), wrong,
      review: attempt.questions.map(review)
    } : null;
    res.set("Cache-Control", "no-store").json({
      ...(attempt.mode !== "exam" || result ? review(question, index) : { selected: state.answers[index].answer }),
      result
    });
  }));
}
