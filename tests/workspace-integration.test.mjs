import { themes, defaultPreferences } from "../public/theme-catalog.js";
import test from "node:test";
import { legalSchema } from "../legal-engine.js";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { migrateWorkspace } from "../workspace-migrations.js";
import { once } from "node:events";
import pg from "pg";
import bcrypt from "bcryptjs";

const testTools = new URL("../.workspace-test/node_modules/", import.meta.url);
const pgliteModule = new URL("@electric-sql/pglite/dist/index.js", testTools);
const hasPostgres = await access(pgliteModule).then(() => true, () => false);

test("workspace HTTP, PostgreSQL migration, role gates and mobile UI", { skip: !hasPostgres, timeout: 360_000 }, async t => {
  const { PGlite } = await import(pgliteModule);
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE rpm_users (
      id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, status TEXT DEFAULT 'active', role TEXT DEFAULT 'customer',
      rp_nickname TEXT, display_name TEXT, avatar_data TEXT, theme TEXT
    );
    CREATE TABLE rpm_devices (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES rpm_users, device_token_hash TEXT UNIQUE,
      device_name TEXT, revoked_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE rpm_sessions (sid TEXT PRIMARY KEY, sess JSON NOT NULL, expire TIMESTAMP NOT NULL);
    CREATE TABLE rpm_cases (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, user_id BIGINT REFERENCES rpm_users, title TEXT, data JSONB, updated_at TIMESTAMPTZ
    );
    CREATE TABLE rpm_case_backups (id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES rpm_users,
      cases JSONB, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE rpm_orders (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES rpm_users, buyer_rp_nickname TEXT NOT NULL,
      plan_code TEXT NOT NULL CHECK (plan_code IN ('7_days', '30_days', '90_days')),
      duration_days INTEGER NOT NULL CHECK (duration_days IN (7, 30, 90)),
      amount BIGINT NOT NULL CHECK (amount > 0), currency TEXT NOT NULL, promo_code TEXT, status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), confirmed_at TIMESTAMPTZ, confirmed_by TEXT
    );
    CREATE TABLE rpm_licenses (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES rpm_users, order_id BIGINT REFERENCES rpm_orders,
      plan_code TEXT NOT NULL CHECK (plan_code IN ('7_days', '30_days', '90_days')),
      status TEXT, starts_at TIMESTAMPTZ, expires_at TIMESTAMPTZ CHECK (expires_at > starts_at)
    );
    CREATE TABLE rpm_partners (id BIGSERIAL PRIMARY KEY, promo_code TEXT, status TEXT, commission_rate NUMERIC);
    CREATE TABLE rpm_referrals (user_id BIGINT UNIQUE, partner_id BIGINT, promo_code TEXT);
    CREATE TABLE rpm_commissions (partner_id BIGINT REFERENCES rpm_partners, order_id BIGINT REFERENCES rpm_orders,
      order_amount BIGINT, commission_rate NUMERIC, commission_amount BIGINT, status TEXT);
    CREATE TABLE rpm_invites (id BIGSERIAL PRIMARY KEY, code_hash TEXT UNIQUE, order_id BIGINT, expires_at TIMESTAMPTZ, status TEXT, used_at TIMESTAMPTZ);
    CREATE TABLE rpm_license_logs (user_id BIGINT, license_id BIGINT, actor_type TEXT, actor_id TEXT, action TEXT, details JSONB);
  `);
  const password = "fixture-password-original";
  const updatedPassword = "fixture-password-changed";
  await db.query(`INSERT INTO rpm_users (username,password_hash,status,role,rp_nickname)
    VALUES ('workspace-staff',$1,'active','admin','Сотрудник'),
           ('workspace-other',$1,'active','admin','Другой сотрудник'),
           ('workspace-owner',$1,'active','admin','Владелец'),
           ('workspace-customer',$1,'active','customer','Покупатель')`, [await bcrypt.hash(password, 4)]);
  await db.exec(`
    INSERT INTO rpm_orders(user_id,buyer_rp_nickname,plan_code,duration_days,amount,currency,status)
      SELECT id,rp_nickname,'7_days',7,300000,'RP','confirmed' FROM rpm_users WHERE role='customer';
    INSERT INTO rpm_licenses(user_id,order_id,plan_code,status,starts_at,expires_at)
      SELECT user_id,id,plan_code,'active',now()-interval '6 days',now()+interval '1 day' FROM rpm_orders;
  `);
  const legacyOrder = (await db.query("SELECT * FROM rpm_orders")).rows[0];
  const legacyLicense = (await db.query("SELECT * FROM rpm_licenses")).rows[0];
  const query = async (statement, args = []) => {
    const result = await db.query(statement, args);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  t.mock.method(pg.Pool.prototype, "query", query);
  t.mock.method(pg.Pool.prototype, "connect", async () => ({ query, release() {} }));
  const migrationPool = {
    connect: async () => ({
      query: (sql, args) => args ? db.query(sql, args) : db.exec(sql),
      release: failed => assert.equal(failed, false)
    })
  };
  await migrateWorkspace(migrationPool);
  await migrateWorkspace(migrationPool);
  assert.equal((await query("SELECT count(*)::int AS count FROM rpm_users")).rows[0].count, 4);
  assert.deepEqual((await query("SELECT * FROM rpm_orders")).rows, [legacyOrder]);
  assert.deepEqual((await query("SELECT * FROM rpm_licenses")).rows, [legacyLicense]);
  const realFetch = globalThis.fetch;
  let modelContext = "";
  const transcript = "CPD, FBI, ФИБ, ЕПК, УК, АК. Alex_Vail назвал статью 12.3.";
  let audioCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!String(url).startsWith("https://generativelanguage.googleapis.com/")) return realFetch(url, options);
    const payload = JSON.parse(options.body);
    if (String(url).endsWith("/models/gemini-3.5-flash-lite:generateContent")) {
      audioCalls++;
      assert.equal(options.headers["x-goog-api-key"], "fixture-model");
      const [language, { inlineData }] = payload.contents[0].parts;
      assert.match(language.text, /ru-RU|en-US/);
      assert.equal(inlineData.mimeType, "audio/wav");
      assert.equal(Buffer.from(inlineData.data, "base64").toString("ascii", 0, 4), "RIFF");
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: transcript }] } }],
        usageMetadata: { totalTokenCount: 200 } });
    }
    const { messages } = payload;
    assert.ok(!messages[0].content.includes("fixture-case-marker"));
    modelContext = messages[1].content;
    if (modelContext.includes("mock-provider-unavailable")) {
      return Response.json({ error: { message: "Fixture unavailable" } }, { status: 503 });
    }
    if (messages[0].content.startsWith("Ты адвокат в RP-системе RPM.")) {
      const [source] = JSON.parse(modelContext).sources;
      const content = { summary: "Уточняется основание задержания.", phrase: "Назовите основание задержания.",
        next: "Уточните статус клиента.", confidence: "medium",
        citation: source ? { sourceId: source.sourceId, reference: source.reference, quote: source.text.slice(0, 32) } : null };
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
    }
    if (payload.response_format) {
      const { sources } = JSON.parse(modelContext);
      const source = sources[0];
      const content = Object.fromEntries(legalSchema.required.map(key => [key, []]));
      Object.assign(content, { summary: "Сводка", confidence: "low", citations: [
        { sourceId: source.sourceId, reference: source.reference, quote: "" },
        { sourceId: "rpm-99", reference: "Вымышленная норма", quote: "" }
      ] });
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
    }
    const legalReasoning = [
      { article: "Устав CPD, глава II, пункт 2.3", whyApplied: "Порядок взаимодействия с гражданами." },
      { article: "Устав CPD, глава II, пункт 2.99" }
    ];
    return Response.json({ choices: [{ message: { content: JSON.stringify({ answer: "Проверка", legalReasoning }) } }] });
  });
  Object.assign(process.env, {
    PORT: "0", DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/fixture",
    GEMINI_API_KEY: "fixture-model", SESSION_SECRET: "workspace-integration-fixture-only-".repeat(3),
    OWNER_USER: "workspace-owner", APP_USER: "workspace-fallback", APP_PASSWORD: "test-only"
  });
  const { server } = await import("../server.js");
  if (!server.listening) await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function send(url, { method = "GET", body, headers = [], cookie = "" } = {}) {
    const response = await fetch(origin + url, {
      method,
      redirect: "manual",
      headers: { cookie, ...Object.fromEntries(headers), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const responseBody = response.headers.get("Content-Type")?.includes("application/json") ? await response.json() : await response.text();
    return { status: response.status, data: responseBody, location: response.headers.get("location"), cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
  }
  const login = (username, input, role = "admin") => send(`/api/${role}/login`, { method: "POST", body: { username, password: input } });

  const anonymous = await send("/admin");
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.location, "/admin-login");
  assert.equal((await send("/api/admin/self")).status, 401);
  assert.equal((await send("/api/documents")).status, 401);
  assert.equal((await send("/api/training/progress")).status, 401);
  assert.equal((await login("workspace-staff", "incorrect")).status, 401);
  const customer = await login("workspace-customer", password, "customer");
  assert.equal(customer.status, 200);
  assert.equal((await send("/admin", { cookie: customer.cookie })).status, 403);
  assert.equal((await send("/training", { cookie: customer.cookie })).status, 200);
  const staff = await login("workspace-staff", password);
  assert.equal(staff.status, 200);
  const { cookie } = staff;
  assert.equal((await send("/index%5Fbackup_before_rewrite.html", { cookie })).status, 404);
  assert.equal((await send("/index.html.backup", { cookie })).status, 404);
  const clientsUrl = "/api/workspace/clients";
  assert.equal((await send(clientsUrl)).status, 401);
  const clientData = { rp_name: "Клиент <em>CPD</em>", organization: "CPD", notes: "Приватная заметка" };
  const createdClient = await send(clientsUrl, { method: "POST", cookie, body: clientData });
  assert.equal(createdClient.status, 201);
  const clientUrl = `${clientsUrl}/${createdClient.data.client.id}`;
  assert.equal((await send(clientUrl, { cookie: customer.cookie })).status, 404);
  assert.equal((await send(clientUrl, { method: "PUT", cookie: customer.cookie, body: clientData })).status, 404);
  assert.deepEqual((await send(clientsUrl, { cookie: customer.cookie })).data.clients, []);
  const foundClient = (await send(`${clientsUrl}?q=CPD&sort=name`, { cookie })).data.clients[0];
  assert.equal(foundClient.rp_name, clientData.rp_name);
  assert.equal(foundClient.notes, undefined);
  assert.equal((await send(clientUrl, { cookie })).data.client.notes, clientData.notes);
  assert.equal((await send(clientUrl, { method: "PUT", cookie, body: { ...clientData, archived: true } })).status, 200);
  assert.deepEqual((await send(clientsUrl, { cookie })).data.clients, []);
  assert.equal((await send(`${clientsUrl}?archived=true`, { cookie })).data.clients[0].id, createdClient.data.client.id);
  const customerAppearance = { theme: "ivory", preferences: { ...defaultPreferences, text: "large" } };
  const patchCustomer = await send("/api/customer/profile", { method: "PATCH", cookie: customer.cookie, body: customerAppearance });
  assert.equal(patchCustomer.status, 200);
  assert.deepEqual(patchCustomer.data.appearance, customerAppearance);
  assert.equal((await send("/api/customer/profile", { cookie: customer.cookie })).data.profile.theme, "ivory");
  const customerRevision = (await send("/api/customer/profile", { cookie: customer.cookie })).data.profile.appearance_revision;
  const staffRevision = (await send("/api/admin/self", { cookie })).data.profile.appearance_revision;
  const changeTheme = revision => send("/api/admin/self/profile", {
    method: "PATCH", cookie, body: customerAppearance, headers: [["If-Match", '"' + revision + '"']]
  });
  assert.notEqual(customerRevision, staffRevision);
  assert.equal((await changeTheme(customerRevision)).status, 409);
  assert.equal((await changeTheme(staffRevision)).status, 200);
  assert.equal((await changeTheme(staffRevision)).status, 409);
  assert.equal((await send("/api/admin/self/profile", { method: "PATCH", cookie: customer.cookie, body: customerAppearance })).status, 403);
  assert.equal((await send("/api/admin/self/profile", { method: "PATCH", cookie, body: { ...customerAppearance, theme: "invalid" } })).status, 400);
  assert.equal((await send("/api/admin/self/profile", { method: "PATCH", cookie, body: customerAppearance, headers: [["Sec-Fetch-Site","cross-site"]] })).status, 403);
  const owner = await login("workspace-owner", password);
  assert.equal(owner.status, 200);
  assert.equal((await send("/owner", { cookie: owner.cookie })).status, 200);
  assert.equal((await send("/api/panel/permissions", { cookie: owner.cookie })).data.isOwner, true);
  assert.equal((await send("/api/admin/self/profile", { method: "PATCH", cookie: owner.cookie, body: customerAppearance })).status, 200);
  assert.equal((await send("/api/panel/profile", { cookie: owner.cookie })).data.profile.theme, "ivory");
  assert.equal((await send("/api/customer/profile", { method: "PUT", cookie: customer.cookie, body: {
    username: "workspace-customer", display_name: "Новое имя", rp_nickname: "Покупатель"
  } })).status, 200);
  await send("/api/customer/logout", { method: "POST", cookie: customer.cookie });
  const customerAgain = await login("workspace-customer", password, "customer");
  const customerProfile = (await send("/api/customer/profile", { cookie: customerAgain.cookie })).data.profile;
  assert.equal(customerProfile.theme, "ivory");
  assert.equal(customerProfile.preferences.text, "large");
  const other = await login("workspace-other", password);
  assert.equal(other.status, 200);
  assert.equal((await send("/owner", { cookie })).status, 403);
  assert.equal((await send("/api/owner/admins", { method: "POST", cookie, body: {} })).status, 403);
  assert.equal((await send("/api/laws", { method: "PUT", cookie, body: {} })).status, 403);
  assert.equal((await send("/admin", { cookie })).status, 200);
  assert.equal((await send("/api/admin/self", { cookie })).data.profile.username, "workspace-staff");
  const profile = await send("/api/admin/self/profile", { method: "PUT", cookie, body: { rp_nickname: "RP", display_name: "<em>Имя</em>" } });
  assert.equal(profile.status, 200);
  assert.equal(profile.data.profile.display_name, "<em>Имя</em>");
  assert.equal((await send("/api/admin/self/profile", { method: "PUT", cookie, body: {
    rp_nickname: "RP", display_name: "Invalid image", avatar_data: "data:image/png;base64,AAAA"
  } })).status, 400);
  const catalog = (await send("/api/documents", { cookie })).data;
  const imported = catalog.filter(doc => ["charter", "oath", "policy"].includes(doc.type));
  assert.equal(imported.length, 8);
  for (const doc of imported) {
    const result = await send("/api/documents/" + doc.id, { cookie });
    assert.equal(result.status, 200);
    assert.ok(result.data.fullText.length > 100);
    assert.ok(!result.data.fullText.includes("\uFFFD"));
  }
  assert.equal((await send("/api/documents/missing", { cookie })).status, 404);
  await db.exec("ALTER TABLE rpm_training_attempts RENAME TO rpm_training_attempts_fixture");
  try {
    const unavailable = await send("/api/training/progress", { cookie });
    assert.equal(unavailable.status, 503);
    assert.match(unavailable.data.error, /002_workspace.sql/);
  } finally {
    await db.exec("ALTER TABLE rpm_training_attempts_fixture RENAME TO rpm_training_attempts");
  }
  await db.exec("ALTER TABLE rpm_admin_activity RENAME TO rpm_admin_activity_fixture");
  try {
    const unavailable = await send("/api/admin/self/profile", { method: "PUT", cookie, body: {
      rp_nickname: "RP", display_name: "Должно откатиться", theme: "graphite"
    } });
    assert.equal(unavailable.status, 503);
    assert.match(unavailable.data.error, /002_workspace.sql/);
    assert.equal((await send("/api/admin/self", { cookie })).data.profile.display_name, "<em>Имя</em>");
  } finally {
    await db.exec("ALTER TABLE rpm_admin_activity_fixture RENAME TO rpm_admin_activity");
  }
  const library = await send("/api/laws", { cookie });
  assert.equal(library.status, 200);
  assert.equal(library.data.articleIndex.epk.length, 51);
  assert.equal(library.data.archivedDocuments.find(doc => doc.id === "epk-archive-1").articles.length, 53);
  const removedEpk = await send("/api/laws", { method: "PUT", cookie: owner.cookie,
    body: { documents: library.data.documents.filter(doc => doc.id !== "epk") } });
  assert.equal(removedEpk.status, 400);
  const epkSearch = await send("/api/laws/search?" + new URLSearchParams({ q: "ЕПК, глава III, статья 3, пункт 3.4" }), { cookie });
  assert.equal(epkSearch.data.totalArticles, 508);
  assert.equal(epkSearch.data.exact.matches[0]?.documentId, "epk");
  assert.ok(epkSearch.data.results.some(article => article.documentId === "epk" && article.anchor));
  const exact = await send("/api/documents/resolve?q=" + encodeURIComponent("ЕПК, глава III, статья 3, пункт 3.4"), { cookie });
  assert.equal(exact.data.status, "confirmed");
  assert.equal((await send("/api/documents/epk", { cookie })).data.history[0].revision, "2026-10-09");
  const search = await send("/api/laws/search?q=" + encodeURIComponent("CPD сотрудники гражданами"), { cookie });
  assert.ok(search.data.results.some(norm => norm.documentId === "charter-cpd"));
  assert.ok(search.data.results.every(norm => !norm.documentId.includes("archive")));
  const analysis = await send("/api/attorney-assist", { method: "POST", cookie, body: {
    mode: "analyze", caseData: { description: "Сотрудники CPD должны уважительно взаимодействовать с гражданами.", notes: "fixture-case-marker" }
  } });
  assert.equal(analysis.status, 200);
  assert.match(modelContext, /Устав ЦПД/u);
  assert.match(modelContext, /fixture-case-marker/);
  assert.match(analysis.data.legalReasoning[0].normText, /уважительно взаимодействовать/u);
  assert.equal(analysis.data.referenceAudit[1].status, "Недостаточно данных для подтверждения");
  assert.equal(analysis.data.legalReasoning[1].normText, "");
  const revisions = (await send("/api/law-revisions", { cookie })).data.revisions;
  const archivedEpk = revisions.find(item => item.documentId === "epk" && item.status === "archived");
  assert.match(archivedEpk.checksum, /^[a-f0-9]{64}$/);
  const compare = await send("/api/law-revisions?" + new URLSearchParams({ before: archivedEpk.id, after: "epk" }), { cookie });
  assert.equal(compare.status, 200);
  assert.ok(compare.data.changes.some(item => item.status !== "unchanged"));
  const archivedAnalysis = await send("/api/attorney-assist", { method: "POST", cookie, body: {
    revisionId: archivedEpk.id, caseData: { description: "ЕПК, статья 4" }
  } });
  assert.equal(archivedAnalysis.status, 200);
  assert.equal(archivedAnalysis.data.sourceEdition.checksum, archivedEpk.checksum);
  assert.doesNotMatch(JSON.parse(modelContext).sources, /Устав ЦПД/u);
  const structuredBody = { format: "structured", mode: "evidence", caseData: {
    description: "Проверка документов сотрудником CPD, fixture-case-marker"
  } };
  const structured = await send("/api/attorney-assist", { method: "POST", cookie: customerAgain.cookie, body: structuredBody });
  assert.equal(structured.status, 200);
  assert.ok(structured.data.citations[0].source.text);
  assert.deepEqual(structured.data.citations.map(item => item.status), ["Подтверждено", "Не найдено"]);
  assert.equal((await send("/api/attorney-assist", { method: "POST", cookie, body: { ...structuredBody, mode: "toString" } })).status, 400);
  assert.equal((await send("/api/attorney-assist", { method: "POST", cookie, body: { revisionId: "unknown" } })).status, 422);
  assert.equal((await send("/api/attorney-assist", { method: "POST", cookie, body: { caseData: [] } })).status, 400);
  assert.equal((await send("/api/attorney-assist", {
    method: "POST", cookie, body: {}, headers: [["Sec-Fetch-Site", "cross-site"]]
  })).status, 403);
  let limited;
  for (let index = 0; index <= 20; index++) {
    limited = await send("/api/attorney-assist", { method: "POST", cookie: other.cookie, body: { caseData: [] } });
    if (limited.status === 429) break;
    assert.equal(limited.status, 400);
  }
  assert.equal(limited.status, 429);

  const changePassword = current => send("/api/admin/self/password", {
    method: "POST", cookie, body: { current, password: updatedPassword, confirmation: updatedPassword }
  });
  assert.equal((await changePassword("incorrect")).status, 400);
  assert.equal((await changePassword(password)).status, 200);
  assert.equal((await login("workspace-staff", password)).status, 401);
  const anotherSession = await login("workspace-staff", updatedPassword);
  assert.equal(anotherSession.status, 200);
  const sessions = await send("/api/admin/self/sessions", { cookie });
  assert.equal(sessions.data.length, 2);
  const selected = sessions.data.find(row => !row.current);
  assert.equal((await send(`/api/admin/self/sessions/${selected.id}`, { method: "DELETE", cookie })).status, 200);
  assert.equal((await send("/admin", { cookie: anotherSession.cookie })).status, 302);
  assert.equal((await send("/admin", { cookie })).status, 200);
  const devices = await send("/api/admin/self/devices", { cookie });
  assert.equal(devices.data.length, 2);
  assert.equal((await send(`/api/admin/self/devices/${devices.data.find(row => !row.current).id}`, { method: "DELETE", cookie })).status, 200);

  const begin = await send("/api/training/attempts", {
    method: "POST", cookie, body: { mode: "quiz", size: 5, documentIds: ["epk", "charter-cpd", "epk-archive-1"] }
  });
  assert.equal(begin.status, 200);
  assert.equal(begin.data.questions.length, 5);
  assert.ok(begin.data.questions.every(question => typeof question.correct === "undefined" && typeof question.choiceSources === "undefined"));
  assert.equal((await send("/api/training/attempts", {
    method: "POST", cookie, body: { mode: "quiz", size: 5, documentIds: ["epk-archive-1"] }
  })).status, 422);
  const answerUrl = `/api/training/attempts/${begin.data.id}/answers`;
  assert.equal((await send(answerUrl, { method: "POST", cookie: other.cookie, body: { index: 0, answer: 0 } })).status, 404);
  const stored = (await db.query("SELECT questions FROM rpm_training_attempts WHERE id=$1", [begin.data.id])).rows[0].questions;
  for (const [index, question] of stored.entries()) {
    const answer = await send(answerUrl, { method: "POST", cookie, body: { index, answer: question.correct } });
    assert.equal(answer.status, 200);
    assert.equal(answer.data.correct, true);
    if (index === 4) assert.equal(answer.data.result.percent, 100);
  }
  assert.equal((await send("/api/training/progress", { cookie })).data.tests, 1);
  assert.equal((await send(`/api/training/attempts/${begin.data.id}/retry`, { method: "POST", cookie })).status, 422);
  assert.equal((await send(`/api/training/attempts/${begin.data.id}/retry`, { method: "POST", cookie: other.cookie })).status, 404);
  assert.equal((await send("/api/training/progress", { cookie: other.cookie })).data.tests, 0);
  const exam = await send("/api/training/attempts", {
    method: "POST", cookie, body: { mode: "exam", size: 10, documentIds: ["epk", "charter-cpd"] }
  });
  assert.equal(exam.status, 200);
  assert.equal(exam.data.questions.length, 10);
  await db.exec(`INSERT INTO rpm_cases(user_id,title,data,updated_at)
    SELECT id,'Private case for global search','{}'::jsonb,now() FROM rpm_users WHERE username='workspace-staff'`);
  const searchPath = "/api/workspace/search?q=private%20case%20for%20global%20search";
  const own = await send(searchPath, { cookie });
  assert.equal(own.data.length, 1);
  assert.deepEqual((await send(searchPath, { cookie: other.cookie })).data, []);
  const favorite = { category: "case", target: own.data[0].target, saved: true };
  assert.equal((await send("/api/workspace/favorites", { method: "PUT", cookie: other.cookie, body: favorite })).status, 404);
  assert.equal((await send("/api/workspace/favorites", { method: "PUT", cookie, body: favorite })).status, 200);
  const [{ created_at, ...savedCase }] = (await send("/api/workspace/favorites", { cookie })).data;
  assert.deepEqual([savedCase], own.data);
  assert.ok(Number.isFinite(Date.parse(created_at)));
  assert.deepEqual((await send("/api/workspace/favorites", { cookie: other.cookie })).data, []);
  await t.test("Live analysis, metrics, saved cases and favorite phrases are protected", async () => {
    const path = "/api/live/analyze";
    const body = { mode: "live_quick_analysis", detail: "brief", entries: [
      { kind: "Факт", text: "Задержание сотрудником CPD" },
      { kind: "Реплика", text: "Сотрудник сообщил об ориентировке" }
    ] };
    const analyze = (auth, input = body, headers) => send(path, { method: "POST", cookie: auth, body: input, headers });
    assert.equal((await analyze("")).status, 401);
    assert.equal((await analyze(cookie, body, [["Sec-Fetch-Site", "cross-site"]])).status, 403);
    assert.equal((await analyze(cookie, { ...body, entries: [] })).status, 400);
    const samples = [];
    for (const detail of ["instant", "brief", "full"]) {
      const response = await analyze(customerAgain.cookie, { ...body, detail });
      assert.equal(response.status, 200);
      assert.equal(response.data.grounds.length, 1);
      assert.ok(response.data.elapsedMs >= 0);
      assert.deepEqual((JSON.parse(modelContext).entries || JSON.parse(modelContext).materials.entries), body.entries);
      samples.push({ detail, elapsedMs: response.data.elapsedMs });
    }
    console.log("Live mock server timings:", samples);
    const fallback = await analyze(customerAgain.cookie, { ...body, detail: "instant",
      entries: [{ kind: "Факт", text: "mock-provider-unavailable" }] });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.data.fallback, true);
    assert.deepEqual(fallback.data.grounds, []);
    const phrases = "/api/live/phrases";
    assert.equal((await send(phrases, { method: "POST", cookie, body: { slot: 0, text: "Личная фраза" } })).status, 204);
    assert.equal((await send(phrases, { cookie })).data.phrases[0].text, "Личная фраза");
    assert.deepEqual((await send(phrases, { cookie: other.cookie })).data.phrases, []);
    const caseId = "ef9438a9-9871-4f94-8fd6-5a748e2a3221";
    const saved = { id: caseId, title: "Live fixture", data: { liveSession: body.entries } };
    assert.equal((await send("/api/cases", { method: "POST", cookie, body: saved })).status, 200);
    assert.equal((await send("/api/cases", { method: "POST", cookie: other.cookie, body: saved })).status, 409);
    assert.ok((await send("/api/cases", { cookie })).data.some(item => item.id === caseId));
    assert.ok(!(await send("/api/cases", { cookie: other.cookie })).data.some(item => item.id === caseId));
    assert.equal((await send("/api/owner/live-metrics", { cookie })).status, 403);
    const metrics = await send("/api/owner/live-metrics", { cookie: owner.cookie });
    assert.equal(metrics.status, 200);
    assert.equal(metrics.data.metrics.filter(item => item.event === "ai_success").length, 3);
    assert.doesNotMatch(JSON.stringify(metrics.data), /ориентировке|Личная фраза/);
  });
  await t.test("Live transcription checks licenses, origin, WAV framing and request limits", async () => {
    const wav = Buffer.alloc(44 + 3200);
    wav.write("RIFF", 0);
    wav.write("WAVEfmt ", 8);
    wav.write("data", 36);
    for (const [offset, value] of [[4, wav.length - 8], [16, 16], [24, 16000], [28, 32000], [40, 3200]]) wav.writeUInt32LE(value, offset);
    for (const [offset, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) wav.writeUInt16LE(value, offset);
    const upload = (auth, body = wav, headers = {}) => realFetch(origin + "/api/live/transcribe", {
      method: "POST", body, headers: { Cookie: auth, "Content-Type": "audio/wav", "X-RPM-Speech-Language": "ru-RU", ...headers }
    });
    assert.equal((await upload("")).status, 401);
    const customerId = (await query("SELECT id FROM rpm_users WHERE username = 'workspace-customer'")).rows[0].id;
    await query("UPDATE rpm_licenses SET status = 'expired' WHERE user_id = $1 AND status = 'active'", [customerId]);
    try {
      assert.equal((await upload(customerAgain.cookie)).status, 401);
    } finally {
      await query("UPDATE rpm_licenses SET status = 'active' WHERE user_id = $1 AND status = 'expired' AND expires_at > now()", [customerId]);
    }
    assert.equal((await upload(cookie, wav, { Origin: "https://example.test" })).status, 403);
    assert.equal((await upload(cookie, wav, { "Content-Type": "audio/webm" })).status, 415);
    assert.equal((await upload(cookie, wav, { "X-RPM-Speech-Language": "de-DE" })).status, 400);
    assert.equal((await upload(other.cookie, Buffer.alloc(960045))).status, 413);
    assert.equal((await upload(other.cookie, Buffer.alloc(100))).status, 400);
    assert.equal(audioCalls, 0);
    const response = await upload(customerAgain.cookie, wav, { Origin: origin, "X-RPM-Speech-Language": "en-US" });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.transcript, transcript);
    assert.ok(result.elapsedMs >= 0);
    for (let i = 0; i < 4; i++) assert.equal((await upload(other.cookie)).status, 200);
    assert.equal((await upload(other.cookie)).status, 429);
    assert.equal(audioCalls, 5);
  });
  const inbox = (await send("/api/workspace/notifications", { cookie: customerAgain.cookie })).data.filter(item => item.id.startsWith("subscription:"));
  assert.equal(inbox.length, 1);
  const read = "/api/workspace/notifications/read";
  assert.equal((await send(read, { method: "POST", cookie, body: { id: inbox[0].id } })).status, 404);
  assert.equal((await send(read, { method: "POST", cookie: customerAgain.cookie, body: { id: inbox[0].id } })).status, 200);
  assert.equal((await send("/api/workspace/notifications", { cookie: customerAgain.cookie })).data[0].read, true);
  const event = await send("/api/workspace/events", { method: "POST", cookie,
    body: { title: "Fixture court meeting", startsAt: new Date(Date.now() + 3600_000).toISOString() } });
  assert.equal(event.status, 201);
  const eventPath = "/api/workspace/events/" + event.data.id;
  const eventChanges = { title: event.data.title, startsAt: event.data.starts_at, category: "court", caseId: own.data[0].target };
  assert.equal((await send(eventPath, { method: "PATCH", cookie: other.cookie, body: eventChanges })).status, 404);
  assert.equal((await send(eventPath, { method: "PATCH", cookie, body: { ...eventChanges, caseId: "missing" } })).status, 404);
  const changed = await send(eventPath, { method: "PATCH", cookie, body: eventChanges });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.case_id, eventChanges.caseId);
  const eventRange = new URLSearchParams({ from: new Date().toISOString(), to: new Date(Date.now() + 86400_000).toISOString() });
  assert.ok((await send("/api/workspace/events?" + eventRange, { cookie })).data.some(item => item.category === "court"));
  assert.deepEqual((await send("/api/workspace/events", { cookie: other.cookie })).data, []);
  assert.equal((await send("/api/workspace/events/" + event.data.id, { method: "DELETE", cookie: other.cookie })).status, 404);
  assert.ok((await send("/api/workspace/notifications", { cookie })).data.some(item => item.id === "event:" + event.data.id));
  assert.equal((await send("/api/workspace/announcements", { method: "POST", cookie, body: { title: "Fixture notice" } })).status, 403);
  assert.equal((await send("/api/workspace/announcements", { method: "POST", cookie: owner.cookie, body: { title: "Fixture notice" } })).status, 201);
  assert.ok((await send("/api/workspace/notifications", { cookie: other.cookie })).data.some(item => item.title === "Fixture notice"));
  assert.ok((await send("/api/workspace/dashboard", { cookie })).data.events.some(item => item.id === event.data.id));
  const examUrl = `/api/training/attempts/${exam.data.id}/answers`;
  const progressBefore = await send("/api/training/progress", { cookie });
  const firstAnswer = await send(examUrl, { method: "POST", cookie, body: { index: 0, answer: 0 } });
  assert.deepEqual(firstAnswer.data, { selected: 0, result: null });
  assert.deepEqual((await send("/api/training/progress", { cookie })).data, progressBefore.data);
  assert.equal((await send("/api/training/attempts/current", { cookie })).data.index, 1);
  assert.equal((await send("/api/training/attempts/current", { cookie: other.cookie })).data, null);
  assert.equal((await send("/api/admin/self/logout", { method: "POST", cookie: other.cookie })).status, 200);
  assert.equal((await send("/api/admin/self", { cookie: other.cookie })).status, 401);
  const activity = (await send("/api/admin/self", { cookie })).data.history.map(row => row.action);
  for (const action of ["Вход", "Профиль", "Смена пароля", "Завершение сессий"]) assert.ok(activity.includes(action));

  await t.test("subscription catalog, verified pricing, order snapshots and manual renewal", async () => {
    const catalogUrl = "/api/subscription-plans";
    const ownerUrl = "/api/owner/subscription-plans";
    const renewalUrl = "/api/customer/renewal-orders";
    const plans = (await send(catalogUrl)).data.plans;
    assert.deepEqual(plans.map(plan => [plan.duration_days, plan.amount]),
      [[1, 60000], [3, 150000], [7, 300000], [14, 750000], [30, 2000000], [60, 3600000], [90, 5000000], [180, 9000000]]);
    assert.deepEqual(plans.map(plan => plan.name), ["Пробный", "Старт", "Недельный", "Стандарт", "Месячный", "Премиум", "Квартальный", "Полугодовой"]);
    assert.equal((await send(ownerUrl, { cookie })).status, 403);
    assert.equal((await send(ownerUrl, { method: "POST", cookie: customerAgain.cookie, body: plans[0] })).status, 403);
    const commissionRate = 7.5;
    const { rows: [partner] } = await query(`INSERT INTO rpm_partners (promo_code,status,commission_rate)
      VALUES ('WORKSPACEPARTNER','active',$1) RETURNING id`, [commissionRate]);
    await query(`INSERT INTO rpm_referrals (user_id,partner_id,promo_code)
      SELECT id,$1,'WORKSPACEPARTNER' FROM rpm_users WHERE username='workspace-customer'`, [partner.id]);
    const confirm = (orderId, as = owner.cookie) => send(`/api/admin/orders/${orderId}/confirm`, { method: "POST", cookie: as, body: {} });
    let expiry = +legacyLicense.expires_at;
    for (const plan of plans) {
      const renewal = await send(renewalUrl, { method: "POST", cookie: customerAgain.cookie,
        body: { plan_code: plan.code === "1_days" ? "1_day" : plan.code, duration_days: 3650, amount: 1 } });
      assert.equal(renewal.status, 201, JSON.stringify(renewal.data));
      const { order } = renewal.data;
      assert.equal(order.plan_code, plan.code);
      assert.equal(order.duration_days, plan.duration_days);
      assert.equal(Number(order.amount), plan.amount);
      assert.equal(order.status, "pending");
      assert.equal((await confirm(order.id, cookie)).status, 403);
      const result = await confirm(order.id);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.deepEqual(result.data.commission, { rate: commissionRate, amount: Math.round(plan.amount * commissionRate / 100) });
      assert.equal(+new Date(result.data.license.starts_at), expiry);
      expiry += plan.duration_days * 86_400_000;
      assert.equal(+new Date(result.data.license.expires_at), expiry);
      assert.equal((await confirm(order.id)).status, 409);
      assert.equal((await query("SELECT count(*)::int AS count FROM rpm_licenses WHERE order_id=$1", [order.id])).rows[0].count, 1);
      assert.equal((await query("SELECT count(*)::int AS count FROM rpm_commissions WHERE order_id=$1", [order.id])).rows[0].count, 1);
    }
    assert.deepEqual((await query("SELECT * FROM rpm_licenses WHERE id=$1", [legacyLicense.id])).rows, [legacyLicense]);
    assert.deepEqual((await query("SELECT * FROM rpm_orders WHERE id=$1", [legacyOrder.id])).rows, [legacyOrder]);
    const account = await send("/api/customer/me", { cookie: customerAgain.cookie });
    assert.equal(account.data.user.duration_days, 180);
    assert.equal(+new Date(account.data.user.expires_at), expiry);

    const newPlan = { duration_days: 5, amount: 120000, sort_order: 0, active: true };
    const created = await send(ownerUrl, { method: "POST", cookie: owner.cookie, body: newPlan });
    assert.equal(created.status, 201);
    const code = created.data.plan.code;
    assert.equal((await send(catalogUrl)).data.plans[0].code, code);
    const expired = await query("INSERT INTO rpm_users(username,rp_nickname,status,role) VALUES ('expired-fixture','Expired fixture','active','customer') RETURNING id");
    await query(`INSERT INTO rpm_licenses(user_id,plan_code,status,starts_at,expires_at) VALUES
      ($1,'7_days','active',now()-interval '8 days',now()-interval '1 day')`, [expired.rows[0].id]);
    const ownerOrder = fields => send("/api/admin/orders", { method: "POST", cookie: owner.cookie, body: { plan_code: code, ...fields } });
    const pending = await ownerOrder({ buyer_rp_nickname: "Expired fixture", amount: 1, duration_days: 1 });
    const invite = await ownerOrder({ buyer_rp_nickname: "New buyer" });
    assert.equal(invite.status, 201);
    assert.ok((await confirm(invite.data.order.id)).data.invite_code);
    assert.equal(pending.status, 201);
    assert.equal(Number(pending.data.order.amount), newPlan.amount);
    const patch = body => send(ownerUrl + "/" + code, { method: "PATCH", cookie: owner.cookie, body });
    assert.equal((await patch({ ...newPlan, duration_days: 0 })).status, 400);
    assert.equal((await patch({ ...newPlan, duration_days: 4, amount: 160000, sort_order: 90 })).status, 200);
    assert.equal((await send(catalogUrl)).data.plans.at(-1).code, code);
    assert.equal((await patch({ ...newPlan, active: false })).status, 200);
    assert.equal((await ownerOrder({ buyer_rp_nickname: "New buyer" })).status, 400);
    assert.equal((await send(renewalUrl, { method: "POST", cookie: customerAgain.cookie, body: { plan_code: code } })).status, 400);
    const before = Date.now();
    const confirmed = await confirm(pending.data.order.id);
    assert.equal(confirmed.status, 200);
    const start = +new Date(confirmed.data.license.starts_at);
    assert.ok(start >= before - 100 && start <= Date.now());
    assert.equal(+new Date(confirmed.data.license.expires_at) - start, 5 * 86_400_000);
    assert.equal((await send(catalogUrl)).data.plans.length, 8);

    const newOrder = await send("/api/admin/orders", { method: "POST", cookie: owner.cookie,
      body: { buyer_rp_nickname: "Клиент регистрации", plan_code: "1_day", promo_code: "WORKSPACEPARTNER" } });
    assert.equal(newOrder.status, 201, JSON.stringify(newOrder.data));
    const newOrderId = newOrder.data.order.id;
    const invitation = await confirm(newOrderId);
    assert.equal(invitation.status, 200);
    assert.equal((await confirm(newOrderId)).status, 409);
    const register = body => send("/api/customer/register", { method: "POST", body });
    const registration = { username: "workspace-new-customer", rpNickname: "Клиент регистрации",
      password, confirmation: password, inviteCode: invitation.data.invite_code };
    assert.equal((await send("/api/customer/register", { method: "POST", body: registration,
      headers: [["Sec-Fetch-Site", "cross-site"]] })).status, 403);
    assert.equal((await register({ ...registration, confirmation: "different" })).status, 400);
    const registered = await register(registration);
    assert.equal(registered.status, 200, JSON.stringify(registered.data));
    assert.ok(registered.cookie);
    assert.equal((await register({ ...registration, username: "workspace-reuse" })).status, 400);
    assert.equal((await query("SELECT count(*)::int AS count FROM rpm_licenses WHERE order_id=$1", [newOrderId])).rows[0].count, 1);
    assert.equal((await query("SELECT count(*)::int AS count FROM rpm_commissions WHERE order_id=$1", [newOrderId])).rows[0].count, 1);

    const expiredOrder = await send("/api/admin/orders", { method: "POST", cookie: owner.cookie,
      body: { buyer_rp_nickname: "Клиент с истёкшим кодом", plan_code: "3_days" } });
    assert.equal(expiredOrder.status, 201);
    const expiredInvite = await confirm(expiredOrder.data.order.id);
    assert.equal(expiredInvite.status, 200);
    await query("UPDATE rpm_invites SET expires_at=now()-INTERVAL '1 minute' WHERE order_id=$1", [expiredOrder.data.order.id]);
    const expiredRegistration = { ...registration, username: "workspace-expired", inviteCode: expiredInvite.data.invite_code };
    for (let attempt = 0; attempt < 2; attempt++) assert.equal((await register(expiredRegistration)).status, 400);
    assert.equal((await query("SELECT count(*)::int AS count FROM rpm_licenses WHERE order_id=$1", [expiredOrder.data.order.id])).rows[0].count, 0);
  });

  await t.test("Live Assistant in a mobile viewport with speech stubs and real HTTP", { skip: !process.env.WORKSPACE_TEST_BROWSER }, async () => {
    const { chromium } = await import(new URL("playwright-core/index.mjs", testTools));
    const browser = await chromium.launch({ executablePath: process.env.WORKSPACE_TEST_BROWSER, headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 375, height: 812 }, permissions: ["clipboard-read", "clipboard-write"] });
      await context.addCookies(cookie.split("; ").map(pair => {
        const separator = pair.indexOf("=");
        return { name: pair.slice(0, separator), value: pair.slice(separator + 1), url: origin };
      }));
      await context.addInitScript(() => {
        const mode = new URL(location.href).searchParams.get("speech");
        localStorage.setItem("rpm.live.engine", mode === "server" ? "auto" : "browser");
        window.nativeSpeechAvailable = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
        let permission = mode === "blocked" ? "denied" : "prompt";
        navigator.permissions.query = async () => ({ state: permission });
        navigator.mediaDevices.enumerateDevices = async () => [
          { kind: "audioinput", label: "Synthetic test input", deviceId: "synthetic" }
        ];
        navigator.mediaDevices.getUserMedia = async constraints => {
          window.captureRequests = (window.captureRequests || 0) + 1;
          window.testDevice = constraints.audio?.deviceId?.exact;
          if (!constraints.audio) throw new Error("Expected audio capture");
          if (mode === "denied") throw new DOMException("", "NotAllowedError");
          if (mode === "missing") throw new DOMException("", "NotFoundError");
          if (mode === "busy") throw new DOMException("", "NotReadableError");
          permission = "granted";
          const audio = new AudioContext();
          const tone = audio.createOscillator();
          const output = audio.createMediaStreamDestination();
          tone.connect(output);
          tone.start();
          await audio.resume();
          const [track] = output.stream.getAudioTracks();
          const stop = track.stop.bind(track);
          track.stop = () => { stop(); void audio.close(); };
          window.testTrack = track;
          return output.stream;
        };
        window.webkitSpeechRecognition = undefined;
        window.SpeechRecognition = mode ? class {
          start(track) {
            window.recognitionUsesCapture = track === window.testTrack && track?.readyState === "live";
            window.testSpeechLanguage = this.lang;
            this.onstart();
            queueMicrotask(() => {
              if (mode === "network" || mode === "no-speech" || mode === "service-not-allowed") {
                this.onerror({ error: mode });
                this.onend();
              } else this.onresult({ results: [
                Object.assign([{ transcript: "Задержание сотрудником СиПиДи" }], { isFinal: true }),
                Object.assign([{ transcript: "промежуточный фрагмент" }], { isFinal: false })
              ] });
            });
          }
          stop() { this.onend(); }
          abort() { this.onend(); }
        } : undefined;
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => {
        if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text());
      });
      await page.goto(origin);
      console.log("Live browser:", browser.version(), await page.evaluate(() => ({ ua: navigator.userAgent, speech: window.nativeSpeechAvailable })));
      await page.locator("#openSidebar").click();
      await page.locator("#sidebarLive").click();
      assert.equal(await page.locator("#openSidebar").getAttribute("aria-expanded"), "false");
      assert.equal(await page.locator("#sidebarLive svg").count(), 1);
      assert.match(await page.locator("#liveSpeech").textContent(), /недоступна/);
      assert.equal(await page.locator("#liveMic").isDisabled(), true);
      assert.equal(await page.locator("#liveDialog").evaluate(node => node.scrollWidth <= node.clientWidth), true);
      assert.equal(await page.locator(".live-grid").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length), 1);
      await page.locator("#liveText").fill("Задержание сотрудником CPD");
      await page.keyboard.press("Control+Enter");
      await page.locator("#liveAnswer dt").first().waitFor();
      assert.equal(await page.locator("#liveMic svg").count(), 1);
      for (const theme of themes) {
        await page.evaluate(async id => (await import("/appearance.js")).applyAppearance({ theme: id }), theme.id);
        assert.equal(await page.locator("#liveAnalyze").evaluate(node => getComputedStyle(node).backgroundColor), "rgb(109, 59, 188)");
        assert.equal(await page.locator("#liveDialog").evaluate(node => node.scrollWidth <= node.clientWidth), true);
        for (const [foreground, background] of [["#liveTitle", ".live-header"], ["#liveAnalyze", "#liveAnalyze"], ["#liveSpeech", ".live-capture"]]) {
          const ratio = await page.evaluate(([foreground, background]) => {
            const luminance = color => {
              const rgb = color.match(/\d+/g).slice(0, 3).map(value => Number(value) / 255);
              const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
              return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
            };
            const ink = luminance(getComputedStyle(document.querySelector(foreground)).color);
            const fill = luminance(background === ".live-capture" ? "rgb(61, 35, 93)"
              : getComputedStyle(document.querySelector(background)).backgroundColor);
            return (Math.max(ink, fill) + .05) / (Math.min(ink, fill) + .05);
          }, [foreground, background]);
          assert.ok(ratio >= 4.5, `${theme.id} ${foreground} contrast ${ratio}`);
        }
      }
      if (process.env.WORKSPACE_TEST_SCREENSHOTS) {
        await page.screenshot({ path: ".workspace-test/live-mobile.png", animations: "disabled" });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.screenshot({ path: ".workspace-test/live-desktop.png", animations: "disabled" });
        await page.setViewportSize({ width: 375, height: 812 });
      }
      const timing = await page.locator("#liveStatus").textContent();
      console.log("Live mock browser timing:", timing);
      assert.match(timing, /Ответ получен за \d+ мс/);
      await page.locator("#liveCopy").click();
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Назовите основание/);
      await page.locator("#liveSave").click();
      await page.getByText("Ситуация сохранена в истории дел.").waitFor();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#liveDialog").evaluate(node => node.open), false);
      assert.equal(await page.locator("#openSidebar").evaluate(node => node === document.activeElement), true);
      for (const [mode, message] of [
        ["denied", /Доступ к микрофону отклонён/], ["blocked", /Микрофон заблокирован/],
        ["missing", /Микрофон не найден/], ["busy", /Микрофон занят/],
        ["network", /Браузерный сервис распознавания не ответил/], ["no-speech", /Речь не обнаружена/],
        ["service-not-allowed", /Сервис распознавания недоступен/]
      ]) {
        await page.goto(origin + "/?speech=" + mode + "#live");
        await page.locator("#liveMic").click();
        await page.getByText(message).waitFor();
        assert.equal(await page.locator("#liveText").isEditable(), true);
        if (mode === "blocked") assert.equal(await page.evaluate(() => window.captureRequests), undefined);
        if (mode === "network") {
          await page.locator("#liveUseServer").click();
          assert.equal(await page.evaluate(() => localStorage.getItem("rpm.live.engine")), "server");
        }
      }
      await page.goto(origin + "/?speech=ok#live");
      await page.locator("#liveDialog[open]").waitFor();
      await page.locator("#liveSettingsOpen").click();
      assert.equal(await page.locator("#liveLanguage").inputValue(), "ru-RU");
      await page.locator("#liveTest").click();
      await page.waitForFunction(() => document.getElementById("liveLevel").value > 0.1);
      await page.locator('#liveDevices option[value="synthetic"]').waitFor({ state: "attached" });
      assert.equal(await page.evaluate(() => window.captureRequests), 1);
      if (process.env.WORKSPACE_TEST_SCREENSHOTS) await page.screenshot({ path: ".workspace-test/live-microphone.png" });
      await page.locator("#liveLanguage").selectOption("en-US");
      await page.locator("#liveSettingsClose").click();
      await page.waitForFunction(() => window.testTrack.readyState === "ended");
      await page.locator("#liveMic").click();
      await page.waitForFunction(() => window.testSpeechLanguage);
      assert.equal(await page.evaluate(() => window.testSpeechLanguage), "en-US");
      assert.equal(await page.evaluate(() => window.recognitionUsesCapture), true);
      assert.equal(await page.evaluate(() => window.captureRequests), 2);
      assert.match(await page.locator("#liveText").inputValue(), /СиПиДи/);
      assert.match(await page.locator("#liveText").inputValue(), /промежуточный фрагмент/);
      assert.equal(await page.locator("#liveAnalyze").isDisabled(), true);
      await page.locator("#liveStop").click();
      assert.doesNotMatch(await page.locator("#liveText").inputValue(), /промежуточный фрагмент/);
      assert.equal(await page.evaluate(() => window.testTrack.readyState), "ended");
      await page.locator("#liveText").fill("Задержание сотрудником CPD");
      await page.locator("#liveAdd").click();
      assert.match(await page.locator("#liveHistory").textContent(), /CPD/);
      await page.locator("#liveCompact").check();
      assert.equal(await page.locator("#liveTemplates").isVisible(), false);
      await page.setViewportSize({ width: 1300, height: 850 });
      const handle = page.locator("#liveTitle");
      const before = await handle.boundingBox();
      await handle.press("ArrowLeft");
      assert.ok((await handle.boundingBox()).x < before.x);
      const grip = await handle.boundingBox();
      await page.mouse.move(grip.x + 20, grip.y + 15);
      await page.mouse.down();
      await page.mouse.move(grip.x + 140, grip.y + 45, { steps: 5 });
      await page.mouse.up();
      assert.ok((await handle.boundingBox()).x > grip.x + 80);
      await page.locator("#liveAnalyze").click();
      await page.locator("#liveAnswer dd").first().waitFor();
      if (process.env.WORKSPACE_TEST_SCREENSHOTS) await page.screenshot({ path: ".workspace-test/live-compact.png" });
      await page.goto(origin + "/?speech=server#live");
      const requestsBefore = audioCalls;
      await page.locator("#liveSettingsOpen").click();
      await page.locator("#liveTest").click();
      await page.locator('#liveDevices option[value="synthetic"]').waitFor({ state: "attached" });
      await page.locator("#liveDevices").selectOption("synthetic");
      await page.locator("#liveSettingsClose").click();
      await page.locator("#liveMic").click();
      await page.getByText("Идёт запись…").waitFor();
      await page.waitForFunction(() => document.getElementById("liveRecordingTime").textContent === "00:01");
      assert.equal(await page.evaluate(() => window.testDevice), "synthetic");
      await page.locator("#liveDiscard").click();
      await page.waitForFunction(() => window.testTrack.readyState === "ended");
      assert.equal(audioCalls, requestsBefore);
      await page.locator("#liveText").fill("Черновик.");
      await page.locator("#liveMic").click();
      await page.waitForFunction(() => document.getElementById("liveRecordingTime").textContent === "00:01");
      if (process.env.WORKSPACE_TEST_SCREENSHOTS) await page.screenshot({ path: ".workspace-test/live-server-recording.png", animations: "disabled" });
      const started = performance.now();
      await page.locator("#liveStop").click();
      await page.getByText("Диктовка готова. Текст можно исправить.").waitFor();
      console.log("Live recording -> transcript (mock provider), ms:", Math.round(performance.now() - started));
      assert.equal(await page.locator("#liveText").inputValue(), "Черновик. " + transcript);
      assert.equal(audioCalls, requestsBefore + 1);
      assert.equal(await page.locator("#liveText").isEditable(), true);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  await t.test("mobile viewport, keyboard toggle and safe profile rendering", { skip: !process.env.WORKSPACE_TEST_BROWSER }, async () => {
    const { chromium } = await import(new URL("playwright-core/index.mjs", testTools));
    const browser = await chromium.launch({ executablePath: process.env.WORKSPACE_TEST_BROWSER, headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 375, height: 812 }, permissions: ["clipboard-read", "clipboard-write"] });
      const page = await context.newPage();
      const errors = [];
      const failedApi = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => {
        if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text());
      });
      page.on("response", response => {
        if (new URL(response.url()).pathname.startsWith("/api/") && response.status() >= 400) failedApi.push(response.url());
      });
      await page.goto(origin + "/app/");
      await page.locator("#publicPlanCards .subscription-card").last().waitFor();
      assert.equal(await page.locator("#publicPlanCards .subscription-card").count(), 8);
      await page.getByLabel("Сравнить тарифы").selectOption("duration_days");
      assert.match(await page.locator("#publicPlanCards .subscription-card").first().textContent(), /1 день/);
      await page.getByRole("button", { name: "Регистрация", exact: true }).click();
      await page.getByRole("button", { name: "Создать аккаунт" }).waitFor();
      await page.locator("#registerPassword + button").click();
      assert.equal(await page.locator("#registerPassword").getAttribute("type"), "text");
      await page.goto(origin + "/admin-login");
      const input = page.locator('[name="password"]');
      await input.fill(updatedPassword);
      const toggle = page.getByRole("button", { name: "Показать пароль" });
      assert.equal(await toggle.evaluate(node => getComputedStyle(node).backgroundColor),
        await page.locator("body").evaluate(node => {
          const sample = document.createElement("div");
          sample.style.backgroundColor = "var(--panel2)";
          node.append(sample);
          const color = getComputedStyle(sample).backgroundColor;
          sample.remove();
          return color;
        }));
      await toggle.focus();
      await page.keyboard.press("Enter");
      assert.equal(await input.getAttribute("type"), "text");
      assert.equal(await input.inputValue(), updatedPassword);
      await page.keyboard.press("Space");
      assert.equal(await input.getAttribute("type"), "password");
      await page.locator('[name="username"]').fill("workspace-staff");
      await page.getByRole("button", { name: "Войти", exact: true }).click();
      await page.waitForURL("**/admin");
      await page.getByText("Здравствуйте, <em>Имя</em>").waitFor();
      assert.equal(await page.locator("#greeting em").count(), 0);
      await page.waitForFunction(() => document.body.dataset.theme === "ivory" &&
        getComputedStyle(document.body).backgroundColor === "rgb(248, 241, 228)");
      const themeStyles = () => page.evaluate(() => {
        const body = getComputedStyle(document.body);
        const panel = getComputedStyle(document.querySelector(".panel"));
        return [body.fontFamily, body.backgroundColor, panel.backgroundColor, panel.borderRadius];
      });
      const cabinetStyles = await themeStyles();
      await page.goto(origin + "/");
      await page.locator(".rpm-metrics .rpm-metric").last().waitFor();
      await page.evaluate(() => window.rpmNavigate("/?tab=laws"));
      const epk = page.locator("#lawsList > details").filter({ hasText: "ЕДИНЫЙ ПРОЦЕССУАЛЬНЫЙ КОДЕКС ШТАТА RPM" });
      await epk.waitFor();
      assert.equal(await page.locator("#lawsList > details").count(), 14);
      assert.equal(await epk.locator(".article").count(), 51);
      assert.match(await page.locator("#lawStats").textContent(), /508/);
      await page.evaluate(() => window.rpmNavigate("/?tab=analysis"));
      await page.locator("#caseDescription").fill("Проверка документов сотрудником CPD");
      await page.locator("#structuredMode").selectOption("evidence");
      await page.locator("#structuredAnalysisButton").click();
      await page.locator("#analysisResult").getByText("Сводка", { exact: true }).waitFor();
      assert.match(await page.locator("#analysisResult").textContent(), /Вымышленная норма · Не найдено/);
      await page.evaluate(() => window.rpmNavigate("/?tab=clients"));
      await page.getByRole("button", { name: "Добавить клиента" }).click();
      await page.locator("#clientEditor [name=rp_name]").fill("Клиент <em>браузерной проверки</em>");
      await page.getByRole("button", { name: "Сохранить клиента" }).click();
      await page.locator("#clientList").getByRole("heading", { name: "Клиент <em>браузерной проверки</em>" }).waitFor();
      assert.equal(await page.locator("#clientList em").count(), 0);
      for (const width of [360, 390, 768, 1024, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        for (const tab of ["dashboard", "calendar", "favorites"]) {
          await page.evaluate(tab => window.rpmNavigate("/?tab=" + tab), tab);
          const ready = { dashboard: ".rpm-metrics", calendar: ".rpm-calendar-grid", favorites: ".rpm-favorite" };
          await page.locator(ready[tab]).first().waitFor();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), tab + " @ " + width);
        }
      }
      await page.locator("#collapseSidebar").click();
      await page.reload();
      await page.waitForFunction(() => document.body.classList.contains("rpm-collapsed"));
      await page.locator("#collapseSidebar").click();
      await page.getByRole("button",{name:"Список",exact:true}).click();
      await page.locator(".rpm-favorites-list").waitFor();
      await page.getByRole("button",{name:"Сетка",exact:true}).click();
      await page.goto(origin + "/?tab=calendar");
      await page.getByRole("button", { name: "Создать событие" }).click();
      await page.getByLabel("Название", { exact: true }).fill("Событие браузерной проверки");
      await page.getByLabel("Категория", { exact: true }).selectOption("consultation");
      await page.getByLabel("Дело", { exact: true }).selectOption(own.data[0].target);
      await page.getByRole("button", { name: "Сохранить", exact: true }).click();
      await page.getByRole("button", { name: "День", exact: true }).click();
      await page.locator(".rpm-calendar-details:visible button").filter({ hasText: "Событие браузерной проверки" }).first().click();
      await page.waitForFunction(id => document.querySelector('dialog[open] select[aria-label="Дело"]')?.value === id, own.data[0].target);
      page.once("dialog", confirmation => confirmation.accept());
      await page.getByRole("button", { name: "Удалить", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      if (process.env.WORKSPACE_TEST_SCREENSHOTS) {
        for (const [tab, selector] of Object.entries({ dashboard: ".rpm-metrics", calendar: ".rpm-calendar-grid", favorites: ".rpm-favorite" })) {
          await page.goto(origin + "/?tab=" + tab);
          await page.locator(selector).first().waitFor();
          await page.locator("#appLoader").waitFor({ state: "hidden" });
          await page.evaluate(async () => (await import("/appearance.js")).applyAppearance({ theme: "quantum-purple" }));
          await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === "rgb(11, 9, 18)");
          await page.screenshot({ path: `.workspace-test/rpm-${tab}.png`, fullPage: true, animations: "disabled" });
        }
      }
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(origin + "/admin");
      await page.getByRole("heading", { name: "Рабочая панель" }).waitFor();
      await page.evaluate(() => { window.workspaceMarker = "same-document"; });
      await page.getByRole("link", { name: "Рабочие инструменты" }).click();
      assert.deepEqual(await themeStyles(), cabinetStyles);
      assert.equal(await page.evaluate(() => window.workspaceMarker), "same-document");
      await page.goBack();
      await page.getByRole("heading", { name: "Рабочая панель" }).waitFor();
      await page.getByRole("link", { name: "Мой профиль" }).click();
      await page.getByLabel("Отображаемое имя").fill("Профиль из браузера");
      await page.getByRole("button", { name: "Graphite Pro", exact: true }).click();
      await page.getByText("Оформление сохранено.").waitFor();
      assert.equal(await page.locator("body").getAttribute("data-theme"), "graphite");
      await page.getByLabel("Аватар", { exact: true }).setInputFiles({
        name: "avatar.png", mimeType: "image/png",
        buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/Q0AAAAASUVORK5CYII=", "base64")
      });
      await page.getByRole("img", { name: "Аватар" }).waitFor();
      await page.getByRole("button", { name: "Сохранить профиль" }).click();
      await page.getByText("Профиль сохранён.").waitFor();
      await page.reload();
      await page.getByRole("heading", { name: "Здравствуйте, Профиль из браузера" }).waitFor();
      await page.getByRole("img", { name: "Аватар" }).waitFor();
      assert.match(await page.locator("#avatar").getAttribute("src"), /^data:image\/png;base64,/);
      assert.equal(await page.locator("body").getAttribute("data-theme"), "graphite");
      await page.getByRole("link", { name: "Безопасность" }).click();
      await page.getByText("текущая сессия").waitFor();
      await page.getByRole("link", { name: "Моя активность" }).click();
      await page.locator("#adminHistory").getByText(/Профиль · Сохранён/).first().waitFor();
      await page.getByRole("link", { name: "Кабинет", exact: true }).click();
      await page.getByRole("heading", { name: "Рабочая панель" }).waitFor();
      await page.evaluate(() => { window.workspaceMarker = "same-document"; });
      await page.locator("#openSidebar").click();
      await page.getByRole("link", { name: "Уставы", exact: true }).click();
      await page.waitForURL("**/charters?type=charter");
      assert.equal(await page.locator('#mainNavigation [data-section="charters"]').getAttribute("aria-current"), "page");
      await page.locator("#openSidebar").click();
      await page.getByRole("link", { name: "RPM Training", exact: true }).click();
      await page.waitForURL("**/training");
      assert.equal(await page.evaluate(() => window.workspaceMarker), "same-document");
      assert.equal(await page.locator("body").getAttribute("data-theme"), "graphite");
      await page.goBack();
      await page.waitForURL("**/charters?type=charter");
      await page.getByRole("heading", { name: "Уставы", exact: true }).waitFor();
      await page.locator("#documents").waitFor();
      await page.route("**/api/documents/charter-cpd", route => route.abort(), { times: 1 });
      await page.locator("#libraryOrganization").selectOption({ label: "CPD" });
      await page.locator("#libraryCatalogSearch").fill("Устав");
      await page.locator("#documentCards").locator('a[href="/charters?doc=charter-cpd"]').click();
      await page.getByRole("button", { name: "Повторить загрузку" }).click();
      await page.locator("#reader").waitFor();
      const sourceText = await page.locator("#text").innerText();
      assert.doesNotMatch(sourceText, /\x1b|\\x1b\[|```ansi/iu);
      await page.locator("#contents summary").click();
      await page.locator("#contents a").first().click();
      const anchored = page.locator("#text .norm:target");
      await anchored.locator(".norm-actions summary").click();
      await anchored.getByRole("button", { name: "Копировать ссылку" }).click();
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /\/charters\?doc=charter-cpd#line-/);
      await page.getByRole("link", { name: "Изучить этот устав" }).click();
      await page.waitForURL("**/training?doc=charter-cpd");
      await page.locator("#selectedTrainingDocuments").getByText(/Устав ЦПД/).waitFor();
      await page.locator("#setup select[name=mode]").selectOption("quiz");
      await page.getByRole("button", { name: "Начать", exact: true }).click();
      for (let index = 0; index < 5; index++) {
        await page.locator("#choices .option").first().click();
        await page.locator("#feedback a").first().waitFor();
        assert.match(await page.locator("#feedback a").first().getAttribute("href"), /doc=charter-cpd#line-/);
        if (index < 4) await page.getByRole("button", { name: "Дальше" }).click();
      }
      await page.locator("#feedback").getByRole("heading", { name: /Результат:/ }).waitFor();
      await page.locator("#summary").getByText(/Тестов: 2/).waitFor();
      const retryErrors = page.getByRole("button", { name: "Повторить ошибки" });
      if (await retryErrors.count()) {
        await retryErrors.click();
        await page.locator("#position").getByText(/^1 из /).waitFor();
      }
      assert.equal(await page.evaluate(() => window.workspaceMarker), "same-document");
      for (const [width, height] of [[1920, 1080], [1366, 768]]) {
        await page.setViewportSize({ width, height });
        assert.ok(await page.locator("#mainNavigation").evaluate(nav => nav.scrollWidth <= nav.clientWidth));
      }
      await page.setViewportSize({ width: 375, height: 812 });
      for (const route of ["/admin", "/charters?doc=charter-cpd", "/training"]) {
        await page.goto(origin + route);
        const selector = route === "/admin" ? "#loadStatus" : route.startsWith("/charters") ? "#libraryStatus" : "#trainingStatus";
        await page.waitForFunction(selector => !document.querySelector(selector).textContent.includes("Загрузка"), selector);
        const width = await page.evaluate(() => ({
          content: document.documentElement.scrollWidth, viewport: window.innerWidth,
          overflow: [...document.querySelectorAll("body *")].filter(node => node.getBoundingClientRect().right > window.innerWidth + 1)
            .slice(0, 5).map(node => node.tagName + "#" + node.id)
        }));
        assert.ok(width.content <= width.viewport, `${route}: ${JSON.stringify(width)}`);
        if (route.startsWith("/charters")) {
          await page.getByRole("searchbox", { name: "Поиск по документу" }).fill("гражданами");
          await page.locator("#matches").getByRole("link").first().click();
          assert.match(new URL(page.url()).hash, /^#line-/);
        }
      }
      await page.getByRole("button", { name: "Начать" }).click();
      await page.getByRole("button", { name: "Показать содержание" }).click();
      await page.getByRole("button", { name: "Знаю" }).click();
      await page.getByRole("button", { name: "Дальше" }).waitFor();
      await page.goto(origin + "/admin#security");
      await page.getByRole("button", { name: "Выйти", exact: true }).click();
      await page.waitForURL("**/admin-login");
      await page.locator('[name="username"]').fill("workspace-staff");
      await page.locator('[name="password"]').fill(updatedPassword);
      await page.getByRole("button", { name: "Войти", exact: true }).click();
      await page.waitForURL("**/admin");
      await page.getByRole("link", { name: "Моя активность" }).click();
      await page.locator("#adminHistory").getByText(/Выход · Выполнен/).waitFor();
      await page.getByRole("link", { name: "Мой профиль" }).click();
      const body = page.locator("body");
      const paletteColor = hex => "rgb(" + hex.match(/[0-9a-f]{2}/gi).map(n => parseInt(n, 16)).join(", ") + ")";
      for (const { id, name, colors, light } of themes) {
        const card = page.getByRole("button", { name, exact: true });
        let immediate;
        await page.route("**/api/admin/self/profile", async route => {
          immediate = await body.getAttribute("data-theme");
          await route.continue();
        }, { times: 1 });
        await card.click();
        await page.getByText("Оформление сохранено.").waitFor();
        assert.equal(immediate, id);
        assert.equal(await body.getAttribute("data-theme"), id);
        await page.waitForFunction(color => getComputedStyle(document.body).backgroundColor === color, paletteColor(colors[0]));
        assert.equal(await body.evaluate(node => getComputedStyle(node).backgroundColor), paletteColor(colors[0]));
        assert.equal(await page.locator("#profile input[name=display_name]").evaluate(node => getComputedStyle(node).color), paletteColor(colors[3]));
        assert.equal(await page.locator("#profile button.primary").evaluate(node => getComputedStyle(node).color), paletteColor(colors[9]));
        assert.equal(await page.locator("html").getAttribute("data-scheme"), light ? "light" : "dark");
        await page.getByRole("link", { name: "Безопасность" }).click();
        assert.equal(await body.getAttribute("data-theme"), id);
        await page.getByRole("link", { name: "Мой профиль" }).click();
        await page.reload();
        await page.locator(`[data-theme-id="${id}"][aria-pressed="true"]`).waitFor();
        assert.equal((await db.query("SELECT theme FROM rpm_users WHERE username='workspace-staff'")).rows[0].theme, id);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.getByRole("link", { name: "Безопасность" }).click();
        await page.getByRole("button", { name: "Выйти", exact: true }).click();
        await page.waitForURL("**/admin-login");
        await page.waitForFunction(id => document.body.dataset.theme === id, id);
        await page.locator('[name="username"]').fill("workspace-staff");
        await page.locator('[name="password"]').fill(updatedPassword);
        await page.getByRole("button", { name: "Войти", exact: true }).click();
        await page.waitForURL("**/admin");
        await page.getByRole("link", { name: "Мой профиль" }).click();
        await page.locator(`[data-theme-id="${id}"][aria-pressed="true"]`).waitFor();
      }
      await page.getByRole("button", { name: "Светлые", exact: true }).click();
      assert.equal(await page.locator(".appearance-card:visible").count(), themes.filter(theme => theme.light).length);
      await page.getByRole("button", { name: "Все", exact: true }).click();
      await page.getByRole("button", { name: "Автоматически", exact: true }).click();
      await page.getByText("Оформление сохранено.").waitFor();
      await page.getByLabel("Палитра в автоматическом режиме").selectOption("light");
      await page.getByText("Оформление сохранено.").waitFor();
      await page.getByLabel("Плотность интерфейса").selectOption("compact");
      await page.getByText("Оформление сохранено.").waitFor();
      await page.getByLabel("Анимации").selectOption("reduce");
      await page.getByText("Оформление сохранено.").waitFor();
      await page.getByLabel("Размер текста").selectOption("large");
      await page.getByText("Оформление сохранено.").waitFor();
      await page.getByLabel("Декоративные эффекты").selectOption("off");
      await page.getByText("Оформление сохранено.").waitFor();
      await page.reload();
      await page.locator('[data-theme-id="auto"][aria-pressed="true"]').waitFor();
      assert.equal(await page.locator("html").getAttribute("data-scheme"), "light");
      assert.equal(await page.locator("html").getAttribute("data-density"), "compact");
      assert.equal(await page.locator("html").getAttribute("data-motion"), "reduce");
      assert.equal(await page.locator("html").getAttribute("data-text-size"), "large");
      assert.equal(await page.locator("html").getAttribute("data-effects"), "off");
      await page.route("**/api/admin/self/profile", route => route.abort(), { times: 1 });
      await page.getByRole("button", { name: "Ivory", exact: true }).click();
      await page.getByText(/Восстановлены прежние настройки/).waitFor();
      assert.equal(await body.getAttribute("data-theme"), "auto");
      await page.keyboard.press("Control+k");
      const globalSearch = page.getByRole("searchbox", { name: "Глобальный поиск" });
      await globalSearch.fill("Private case for global search");
      await page.getByRole("link", { name: "Private case for global search" }).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Уведомления", exact: true }).click();
      await page.getByText("Fixture court meeting", { exact: false }).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Создать свою тему" }).click();
      await page.getByLabel("Название", { exact: true }).fill("Моя тестовая тема");
      await page.getByRole("button", { name: "Сохранить тему", exact: true }).click();
      await page.getByText("Оформление сохранено.").waitFor();
      const custom = page.getByRole("button", { name: "Моя тестовая тема", exact: true });
      await custom.waitFor();
      assert.equal(await custom.getAttribute("aria-pressed"), "true");
      await page.reload();
      await custom.waitFor();
      assert.equal(await custom.getAttribute("aria-pressed"), "true");
      await page.getByRole("button", { name: "Избранное — Моя тестовая тема" }).click();
      await page.getByText("Оформление сохранено.").waitFor();
      await page.getByRole("button", { name: "Избранные", exact: true }).click();
      assert.equal(await page.locator(".appearance-card:visible").count(), 1);
      await page.getByRole("button", { name: "Мои", exact: true }).click();
      await page.getByRole("button", { name: "Изменить", exact: true }).click();
      await page.getByLabel("Название", { exact: true }).fill("Тестовая тема редактора");
      await page.getByLabel("Скругление кнопок").fill("23");
      await page.getByRole("button", { name: "Сохранить тему", exact: true }).click();
      await page.getByText("Оформление сохранено.").waitFor();
      await page.getByRole("button", { name: "Мои", exact: true }).click();
      const secondTab = await context.newPage();
      await secondTab.goto(page.url());
      await secondTab.getByRole("button", { name: "Тестовая тема редактора", exact: true }).waitFor();
      await page.locator('.appearance-toolbar input[type="file"]').setInputFiles({
        name: "invalid.json", mimeType: "application/json", buffer: Buffer.from('{"html":"<script>"}')
      });
      await page.getByText("Файл не содержит допустимую тему RPM.").waitFor();
      const downloadEvent = page.waitForEvent("download");
      await page.getByRole("button", { name: "Экспорт JSON", exact: true }).click();
      const exported = await downloadEvent;
      const chunks = [];
      for await (const chunk of await exported.createReadStream()) chunks.push(chunk);
      const json = Buffer.concat(chunks);
      assert.equal(JSON.parse(json).theme.buttonRadius, 23);
      await page.locator('.appearance-toolbar input[type="file"]').setInputFiles({
        name: "theme.json", mimeType: "application/json", buffer: json
      });
      await page.getByRole("heading", { name: "Предпросмотр импорта" }).waitFor();
      assert.equal(await page.getByLabel("Название", { exact: true }).inputValue(), "Тестовая тема редактора (2)");
      await page.getByRole("button", { name: "Импортировать тему", exact: true }).click();
      await page.getByText("Оформление сохранено.").waitFor();
      await secondTab.getByRole("button", { name: "Тестовая тема редактора (2)", exact: true }).waitFor();
      await secondTab.close();
      await page.getByRole("button", { name: "Мои", exact: true }).click();
      assert.equal(await page.locator(".appearance-card:visible").count(), 2);
      const importedCard = page.locator(".appearance-tile").filter({ has: page.getByRole("button", {
        name: "Тестовая тема редактора (2)", exact: true
      }) });
      await importedCard.getByRole("button", { name: "Изменить", exact: true }).click();
      page.once("dialog", dialog => dialog.accept());
      await page.getByRole("button", { name: "Удалить тему", exact: true }).click();
      await page.getByText("Оформление сохранено.").waitFor();
      assert.equal(await importedCard.count(), 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(failedApi, []);
    } finally { await browser.close(); }
  });
});

