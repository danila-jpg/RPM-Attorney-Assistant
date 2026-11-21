import { themes, defaultPreferences } from "../public/theme-catalog.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { once } from "node:events";
import pg from "pg";
import bcrypt from "bcryptjs";

const testTools = new URL("../.workspace-test/node_modules/", import.meta.url);
const pgliteModule = new URL("@electric-sql/pglite/dist/index.js", testTools);
const hasPostgres = await access(pgliteModule).then(() => true, () => false);

test("workspace HTTP, PostgreSQL migration, role gates and mobile UI", { skip: !hasPostgres, timeout: 120_000 }, async t => {
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
    CREATE TABLE rpm_licenses (user_id BIGINT, status TEXT, starts_at TIMESTAMPTZ, expires_at TIMESTAMPTZ);
  `);
  await db.exec(await readFile(new URL("../migrations/002_workspace.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../migrations/003_appearance.sql", import.meta.url), "utf8"));
  const password = "fixture-password-original";
  const updatedPassword = "fixture-password-changed";
  await db.query(`INSERT INTO rpm_users (username,password_hash,status,role,rp_nickname)
    VALUES ('workspace-staff',$1,'active','admin','Сотрудник'),
           ('workspace-other',$1,'active','admin','Другой сотрудник'),
           ('workspace-owner',$1,'active','admin','Владелец'),
           ('workspace-customer',$1,'active','customer','Покупатель')`, [await bcrypt.hash(password, 4)]);
  await db.exec("INSERT INTO rpm_licenses SELECT id,'active',now()-interval '1 day',now()+interval '1 day' FROM rpm_users WHERE role='customer'");
  const query = async (statement, args = []) => {
    const result = await db.query(statement, args);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  t.mock.method(pg.Pool.prototype, "query", query);
  t.mock.method(pg.Pool.prototype, "connect", async () => ({ query, release() {} }));
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
  assert.ok(begin.data.questions.every(question => typeof question.correct === "undefined" && !question.documentId.includes("archive")));
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
  assert.equal((await send("/api/admin/self/logout", { method: "POST", cookie: other.cookie })).status, 200);
  assert.equal((await send("/api/admin/self", { cookie: other.cookie })).status, 401);
  const activity = (await send("/api/admin/self", { cookie })).data.history.map(row => row.action);
  for (const action of ["Вход", "Профиль", "Смена пароля", "Завершение сессий"]) assert.ok(activity.includes(action));

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
      await page.getByRole("button", { name: "Graphite", exact: true }).click();
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
      assert.deepEqual(errors, []);
      assert.deepEqual(failedApi, []);
    } finally { await browser.close(); }
  });
});

