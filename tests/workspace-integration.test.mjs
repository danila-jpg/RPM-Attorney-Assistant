import { themes, defaultPreferences } from "../public/theme-catalog.js";
import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { migrateWorkspace } from "../workspace-migrations.js";
import { once } from "node:events";
import pg from "pg";
import bcrypt from "bcryptjs";

const testTools = new URL("../.workspace-test/node_modules/", import.meta.url);
const pgliteModule = new URL("@electric-sql/pglite/dist/index.js", testTools);
const hasPostgres = await access(pgliteModule).then(() => true, () => false);

test("workspace HTTP, PostgreSQL migration, role gates and mobile UI", { skip: !hasPostgres, timeout: 240_000 }, async t => {
  const { PGlite } = await import(pgliteModule);
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE rpm_users (
      id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, status TEXT, role TEXT,
      rp_nickname TEXT, display_name TEXT, avatar_data TEXT, theme TEXT
    );
    CREATE TABLE rpm_devices (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES rpm_users, device_token_hash TEXT UNIQUE,
      device_name TEXT, revoked_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE rpm_sessions (sid TEXT PRIMARY KEY, sess JSON NOT NULL, expire TIMESTAMP NOT NULL);
    CREATE TABLE rpm_cases (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES rpm_users, title TEXT, data JSONB, updated_at TIMESTAMPTZ
    );
    CREATE TABLE rpm_case_backups (user_id BIGINT REFERENCES rpm_users);
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
    CREATE TABLE rpm_referrals (user_id BIGINT, partner_id BIGINT, promo_code TEXT);
    CREATE TABLE rpm_invites (code_hash TEXT, order_id BIGINT, expires_at TIMESTAMPTZ, status TEXT);
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
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!String(url).startsWith("https://generativelanguage.googleapis.com/")) return realFetch(url, options);
    modelContext = JSON.parse(options.body).messages[0].content;
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
  const exact = await send("/api/documents/resolve?q=" + encodeURIComponent("ЕПК, глава III, статья 3, пункт 3.4"), { cookie });
  assert.equal(exact.data.status, "confirmed");
  assert.equal((await send("/api/documents/epk", { cookie })).data.history[0].revision, "2026-10-09");
  const search = await send("/api/laws/search?q=" + encodeURIComponent("CPD сотрудники гражданами"), { cookie });
  assert.ok(search.data.results.some(norm => norm.documentId === "charter-cpd"));
  assert.ok(search.data.results.every(norm => !norm.documentId.includes("archive")));
  const analysis = await send("/api/attorney-assist", { method: "POST", cookie, body: {
    mode: "analyze", caseData: { description: "Сотрудники CPD должны уважительно взаимодействовать с гражданами." }
  } });
  assert.equal(analysis.status, 200);
  assert.match(modelContext, /Устав ЦПД/u);
  assert.match(analysis.data.legalReasoning[0].normText, /уважительно взаимодействовать/u);
  assert.equal(analysis.data.referenceAudit[1].status, "Недостаточно данных для подтверждения");
  assert.equal(analysis.data.legalReasoning[1].normText, "");

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
  assert.deepEqual((await send("/api/workspace/favorites", { cookie })).data, own.data);
  assert.deepEqual((await send("/api/workspace/favorites", { cookie: other.cookie })).data, []);
  const inbox = (await send("/api/workspace/notifications", { cookie: customerAgain.cookie })).data.filter(item => item.id.startsWith("subscription:"));
  assert.equal(inbox.length, 1);
  const read = "/api/workspace/notifications/read";
  assert.equal((await send(read, { method: "POST", cookie, body: { id: inbox[0].id } })).status, 404);
  assert.equal((await send(read, { method: "POST", cookie: customerAgain.cookie, body: { id: inbox[0].id } })).status, 200);
  assert.equal((await send("/api/workspace/notifications", { cookie: customerAgain.cookie })).data[0].read, true);
  const event = await send("/api/workspace/events", { method: "POST", cookie,
    body: { title: "Fixture court meeting", startsAt: new Date(Date.now() + 3600_000).toISOString() } });
  assert.equal(event.status, 201);
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
    assert.equal((await send(ownerUrl, { cookie })).status, 403);
    assert.equal((await send(ownerUrl, { method: "POST", cookie: customerAgain.cookie, body: plans[0] })).status, 403);
    const confirm = (orderId, as = owner.cookie) => send(`/api/admin/orders/${orderId}/confirm`, { method: "POST", cookie: as, body: {} });
    let expiry = +legacyLicense.expires_at;
    for (const plan of plans) {
      const renewal = await send(renewalUrl, { method: "POST", cookie: customerAgain.cookie,
        body: { plan_code: plan.code, duration_days: 3650, amount: 1 } });
      assert.equal(renewal.status, 201, JSON.stringify(renewal.data));
      const { order } = renewal.data;
      assert.equal(order.duration_days, plan.duration_days);
      assert.equal(Number(order.amount), plan.amount);
      assert.equal(order.status, "pending");
      assert.equal((await confirm(order.id, cookie)).status, 403);
      const result = await confirm(order.id);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(+new Date(result.data.license.starts_at), expiry);
      expiry += plan.duration_days * 86_400_000;
      assert.equal(+new Date(result.data.license.expires_at), expiry);
      assert.equal((await confirm(order.id)).status, 409);
      assert.equal((await query("SELECT count(*)::int AS count FROM rpm_licenses WHERE order_id=$1", [order.id])).rows[0].count, 1);
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
      await page.getByRole("button", { name: "Показать пароль" }).click();
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
      await page.getByRole("link", { name: "Уставы", exact: true }).click();
      await page.waitForURL("**/charters");
      assert.equal(await page.getByRole("link", { name: "Уставы", exact: true }).getAttribute("aria-current"), "page");
      await page.getByRole("link", { name: "Обучение", exact: true }).click();
      await page.waitForURL("**/training");
      assert.equal(await page.evaluate(() => window.workspaceMarker), "same-document");
      assert.equal(await page.locator("body").getAttribute("data-theme"), "graphite");
      await page.goBack();
      await page.waitForURL("**/charters");
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

