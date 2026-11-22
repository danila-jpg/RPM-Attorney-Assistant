import { byId, element, request } from "./workspace-common.js";

const categories = { law: "Статьи", charter: "Пункты уставов", document: "Документы", case: "Дела и анализ", question: "Вопросы" };
const button = (name, callback) => {
  const item = element("button", name, { class: "secondary", type: "button" });
  item.addEventListener("click", callback);
  return item;
};
const status = () => element("p", "", { role: "status" });

export function favoriteControl(category, target, feedback, saved = false, changed = () => {}) {
  const item = button(saved ? "Убрать из избранного" : "В избранное", async () => {
    item.disabled = true;
    try {
      ({ saved } = await request("/api/workspace/favorites", "PUT", { category, target, saved: !saved }));
      item.textContent = saved ? "Убрать из избранного" : "В избранное";
      item.setAttribute("aria-pressed", String(saved));
      feedback.textContent = saved ? "Добавлено в избранное." : "Удалено из избранного.";
      changed();
    } catch (error) { feedback.textContent = error.message; }
    finally { item.disabled = false; }
  });
  item.setAttribute("aria-pressed", String(saved));
  return item;
}

function resultList(rows, feedback, saved = false, refresh, controls = true) {
  const list = element("ul", "", { class: "personal-results" });
  for (const row of rows) {
    const link = element("a", row.title, { href: row.href });
    const item = element("li");
    item.append(link, element("small", categories[row.category] || ""));
    if (controls) item.append(favoriteControl(row.category, row.target, feedback, saved, refresh));
    list.append(item);
  }
  return rows.length ? list : element("p", "Ничего не найдено.");
}

function dialog(title) {
  const panel = element("dialog", "", { class: "personal-dialog" });
  panel.setAttribute("aria-label", title);
  panel.append(element("h2", title), button("Закрыть", () => panel.close()));
  panel.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      panel.close();
    }
  });
  panel.addEventListener("click", event => {
    if (event.target.closest("a")) panel.close();
  });
  document.body.append(panel);
  return panel;
}

const search = dialog("Поиск по RPM");
const query = element("input", "", { type: "search", "aria-label": "Глобальный поиск", placeholder: "Норма, документ, дело или учебный вопрос" });
const searchStatus = status();
const results = element("div");
search.append(query, searchStatus, results);
let generation = 0;
let timer;
query.addEventListener("input", () => {
  clearTimeout(timer);
  const current = ++generation;
  const term = query.value.trim();
  results.replaceChildren();
  searchStatus.textContent = term.length < 2 ? "Введите хотя бы два символа." : "Поиск…";
  if (term.length < 2) return;
  timer = setTimeout(async () => {
    try {
      const rows = await request("/api/workspace/search?q=" + encodeURIComponent(term));
      if (current !== generation) return;
      searchStatus.textContent = "";
      results.replaceChildren(resultList(rows, searchStatus));
    } catch (error) {
      if (current === generation) searchStatus.textContent = error.message;
    }
  }, 200);
});
function openSearch() {
  if (!search.open) search.showModal();
  query.focus();
}
byId("workspaceSearch").addEventListener("click", openSearch);
window.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openSearch();
  }
});

const inbox = dialog("Уведомления");
const inboxStatus = status();
const messages = element("div");
inbox.append(inboxStatus, messages);
async function showInbox() {
  inboxStatus.textContent = "Загрузка…";
  try {
    const notices = await request("/api/workspace/notifications");
    const items = notices.map(notice => {
      const item = element("li");
      item.append(notice.href ? element("a", notice.title, { href: notice.href }) : element("span", notice.title));
      if (notice.read) item.append(element("small", "Прочитано"));
      else item.append(button("Отметить прочитанным", async event => {
        const control = event.currentTarget;
        control.disabled = true;
        try {
          await request("/api/workspace/notifications/read", "POST", { id: notice.id });
          await showInbox();
        } catch (error) { inboxStatus.textContent = error.message; control.disabled = false; }
      }));
      return item;
    });
    const list = element("ul", "", { class: "personal-results" });
    list.append(...items);
    messages.replaceChildren(items.length ? list : element("p", "Уведомлений пока нет."));
    inboxStatus.textContent = "";
  } catch (error) { inboxStatus.textContent = error.message; }
}
byId("workspaceNotifications").addEventListener("click", () => {
  if (!inbox.open) inbox.showModal();
  showInbox();
});

async function showFavorites(container) {
  const field = element("input", "", { type: "search", "aria-label": "Поиск в избранном", placeholder: "Поиск в избранном" });
  const select = element("select", "", { "aria-label": "Категория избранного" });
  select.append(new Option("Все категории", ""), ...Object.entries(categories).map(([id, label]) => new Option(label, id)));
  const output = element("div");
  const feedback = status();
  container.replaceChildren(field, select, feedback, output);
  let items = [];
  const render = () => {
    const query = field.value.trim().toLowerCase();
    const shown = items.filter(row => (!select.value || row.category === select.value) && row.title.toLowerCase().includes(query));
    output.replaceChildren(resultList(shown, feedback, true, refresh));
  };
  async function refresh() {
    try { items = await request("/api/workspace/favorites"); render(); }
    catch (error) { feedback.textContent = error.message; }
  }
  field.addEventListener("input", render);
  select.addEventListener("change", render);
  await refresh();
}

async function dashboard(container) {
  container.replaceChildren(element("p", "Загрузка…"));
  try {
    const [data, favorites] = await Promise.all([request("/api/workspace/dashboard"), request("/api/workspace/favorites")]);
    const feedback = status();
    const section = (title, ...children) => {
      const panel = element("section", "", { class: "panel" });
      panel.append(element("h2", title), ...children);
      return panel;
    };
    container.replaceChildren(
      section(data.name ? "Здравствуйте, " + data.name : "Здравствуйте",
        element("p", data.expires ? "Подписка действует до " + new Date(data.expires).toLocaleDateString("ru") : "Активной подписки нет."),
        element("a", "Начать анализ дела", { href: "/?tab=analysis" }), document.createTextNode(" · "),
        element("a", "Открыть обучение", { href: "/training" })),
      section("Последние дела", resultList(data.cases, feedback, false, undefined, false)),
      section("Недавние документы", resultList(data.recentDocuments, feedback, false, undefined, false)),
      section("Ближайшие события", eventList(data.events), element("a", "Открыть календарь", { href: "/?tab=calendar" })),
      section("Прогресс обучения", element("p", "Завершённых тестов: " + data.progress.tests + ". Верных ответов: " + data.progress.correct + ".")),
      section("Избранные нормы", resultList(favorites.filter(row => ["law", "charter", "document"].includes(row.category)), feedback, false, undefined, false))
    );
    if (data.canAnnounce) container.append(section("Системные сообщения", announcementForm()));
  } catch (error) { container.replaceChildren(element("p", error.message)); }
}

function eventList(events, remove) {
  const list = element("ul", "", { class: "personal-results" });
  for (const event of events) {
    const item = element("li");
    item.append(element("span", event.title), element("time", new Date(event.starts_at).toLocaleString("ru"), { datetime: event.starts_at }));
    if (remove) item.append(button("Удалить", () => remove(event.id)));
    list.append(item);
  }
  return events.length ? list : element("p", "Ближайших событий нет.");
}

async function calendar(container) {
  const form = element("form", "", { class: "panel" });
  const title = element("input", "", { required: "", maxlength: "120", "aria-label": "Название события", placeholder: "Название события" });
  const date = element("input", "", { required: "", type: "datetime-local", "aria-label": "Начало события" });
  const submit = element("button", "Добавить событие", { class: "primary" });
  const output = element("div");
  const feedback = status();
  form.append(title, date, submit);
  container.replaceChildren(form, feedback, output);
  const refresh = async () => {
    const events = await request("/api/workspace/events");
    output.replaceChildren(eventList(events, async id => {
      try { await request("/api/workspace/events/" + id, "DELETE"); await refresh(); }
      catch (error) { feedback.textContent = error.message; }
    }));
  };
  form.addEventListener("submit", async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await request("/api/workspace/events", "POST", { title: title.value, startsAt: new Date(date.value).toISOString() });
      form.reset();
      feedback.textContent = "Событие добавлено.";
      await refresh();
    } catch (error) { feedback.textContent = error.message; }
    finally { submit.disabled = false; }
  });
  try { await refresh(); }
  catch (error) { feedback.textContent = error.message; }
}

function announcementForm() {
  const form = element("form");
  const title = element("input", "", { required: "", maxlength: "240", "aria-label": "Текст сообщения" });
  const submit = element("button", "Опубликовать для пользователей", { class: "primary" });
  const feedback = status();
  form.append(title, submit, feedback);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await request("/api/workspace/announcements", "POST", { title: title.value });
      form.reset();
      feedback.textContent = "Сообщение опубликовано.";
    } catch (error) { feedback.textContent = error.message; }
    finally { submit.disabled = false; }
  });
  return form;
}

export function openView(_url, tab) {
  if (tab === "dashboard") return dashboard(byId("personalDashboard"));
  if (tab === "calendar") return calendar(byId("personalCalendar"));
  if (tab === "favorites") return showFavorites(byId("personalFavorites"));
}
