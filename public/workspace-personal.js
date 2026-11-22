import { byId, element, request } from "./workspace-common.js";

import { addIcon } from "./rpm-shell.js";
import { calendar } from "./workspace-calendar.js";

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
    if (row.created_at && !controls) item.append(element("time", new Date(row.created_at).toLocaleDateString("ru"), { datetime: row.created_at }));
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

const favoriteLabels = { law: "Законы", article: "Статьи", document: "Документы", case: "Дела", question: "Учебные вопросы" };
const actionLink = (label, href, icon, primary = false) => {
  const link = element("a", label, { href, class: "rpm-action" + (primary ? " rpm-primary" : "") });
  if (icon) addIcon(link, icon);
  return link;
};
const card = (title, ...children) => {
  const panel = element("section", "", { class: "panel" });
  panel.append(element("h2", title), ...children);
  return panel;
};

async function showFavorites(container) {
  const field = element("input", "", { type: "search", "aria-label": "Поиск в избранном", placeholder: "Поиск в избранном" });
  const select = element("select", "", { "aria-label": "Категория избранного" });
  const output = element("div");
  const feedback = status();
  const toolbar = element("div", "", { class: "rpm-toolbar" });
  const view = element("div", "", { class: "rpm-segments", role: "group", "aria-label": "Вид избранного" });
  let layout = "grid";
  try { if (localStorage.getItem("rpm-favorites-layout") === "list") layout = "list"; } catch {}
  const switches = [["grid", "Сетка"], ["list", "Список"]].map(([key, label]) => {
    const control = button(label, () => {
      layout = key;
      try { localStorage.setItem("rpm-favorites-layout", key); } catch {}
      render();
    });
    control.dataset.layout = key;
    return control;
  });
  view.append(...switches);
  toolbar.append(field, select, view);
  container.replaceChildren(toolbar, feedback, output);
  let items = [];
  const typeOf = row => row.type || row.category;
  function render() {
    switches.forEach(control => control.setAttribute("aria-pressed", String(control.dataset.layout === layout)));
    const query = field.value.trim().toLocaleLowerCase("ru");
    const shown = items.filter(row => (!select.value || typeOf(row) === select.value) &&
      [row.title, row.description].some(value => value?.toLocaleLowerCase("ru").includes(query)));
    toolbar.hidden = items.length === 0;
    if (!shown.length) {
      const empty = element("section", "", { class: "panel rpm-empty" });
      const icon = element("div", "", { class: "rpm-empty-icon" });
      addIcon(icon, "bookmark");
      empty.append(icon, element("h2", items.length ? "По этим фильтрам ничего не найдено" : "Здесь пока ничего нет"),
        element("p", items.length ? "Измените поисковый запрос или категорию." :
          "Сохраняйте важные законы, статьи и материалы, чтобы быстро находить их позже"));
      empty.append(items.length ? button("Сбросить фильтры", () => { field.value = ""; select.value = ""; render(); })
        : actionLink("Перейти к законам", "/?tab=laws", "book", true));
      output.className = "";
      output.replaceChildren(empty);
      return;
    }
    output.className = "rpm-favorites-" + layout;
    output.replaceChildren(...shown.map(row => {
      const item = element("article", "", { class: "panel rpm-favorite" });
      const label = favoriteLabels[typeOf(row)];
      item.append(element("small", label), element("h2", row.title),
        element("p", row.description || "Сохранено из раздела «" + label + "»."));
      if (row.created_at) item.append(element("time", new Date(row.created_at).toLocaleDateString("ru"), { datetime: row.created_at }));
      const actions = element("div", "", { class: "rpm-actions" });
      actions.append(actionLink("Открыть", row.href), favoriteControl(row.category, row.target, feedback, true, () => {
        items = items.filter(item => item.target !== row.target || item.category !== row.category);
        render();
        (output.querySelector("a,button") || field).focus();
      }));
      item.append(actions);
      return item;
    }));
  }
  field.addEventListener("input", render);
  select.addEventListener("change", render);
  feedback.textContent = "Загрузка…";
  try {
    items = await request("/api/workspace/favorites");
    select.append(new Option("Все", ""), ...Object.entries(favoriteLabels).map(([id,label]) => new Option(label,id)));
    feedback.textContent = "";
    render();
  } catch (error) { feedback.textContent = error.message; }
}

async function dashboard(container) {
  container.replaceChildren(element("p", "Загрузка…", { role: "status" }));
  try {
    const [data, favorites] = await Promise.all([request("/api/workspace/dashboard"), request("/api/workspace/favorites")]);
    const hero = element("div", "", { class: "rpm-hero" });
    const intro = element("div");
    intro.append(element("h1", data.name ? "Добро пожаловать, " + data.name : "Добро пожаловать"),
      element("p", "Ведите дела, работайте с правовыми материалами и планируйте ближайшие сроки."));
    const subscription = element("div", "", { class: "rpm-subscription" });
    subscription.append(element("strong", "Подписка"), element("p", data.expires && Date.parse(data.expires) > Date.now()
      ? "Действует до " + new Date(data.expires).toLocaleDateString("ru") : "Активной подписки нет"));
    hero.append(intro, subscription);
    const metrics = element("div", "", { class: "rpm-metrics" });
    for (const [title, value, description, glyph] of [
      ["Активные дела", data.counts.cases, "Дела в рабочем пространстве", "briefcase"],
      ["Созданные документы", data.counts.documents, "Сформированные PDF", "files"],
      ["Пройденные экзамены", data.counts.exams, "Завершённые экзамены RPM", "graduation"],
      ["Сохранённые нормы", data.counts.norms, "Статьи и пункты уставов", "bookmark"]
    ]) {
      const item = element("section", "", { class: "panel rpm-metric" });
      const icon = element("span", "", { class: "rpm-stat-icon" });
      addIcon(icon, glyph);
      item.append(icon, element("h3", title), element("strong", value), element("small", description));
      metrics.append(item);
    }
    const actions = element("div", "", { class: "rpm-actions" });
    actions.append(actionLink("Новый анализ", "/?tab=analysis&new=1", "scale", true),
      actionLink("Создать дело", data.isAdmin ? "/?tab=analysis&new=1#caseTitle" : "/app/account.html#customerCaseTitle", "briefcase"),
      actionLink("Создать документ", "/?tab=analysis#documentExport", "files"),
      actionLink("Начать обучение", "/training", "graduation"));
    const grid = element("div", "", { class: "rpm-dashboard-grid" });
    const left = element("div");
    const right = element("div");
    const norms = favorites.filter(row => row.category === "law" || row.category === "charter").slice(0, 5);
    const rows = records => records.length ? resultList(records, null, false, undefined, false)
      : element("p", "Записей пока нет.", { class: "muted" });
    left.append(card("Последние дела", rows(data.cases), actionLink("История дел", "/?tab=history")),
      card("Недавние документы", rows(data.recentDocuments)));
    right.append(card("Ближайшие события", eventList(data.events), actionLink("Открыть календарь", "/?tab=calendar")),
      card("Прогресс обучения", element("p", "Пройдено тестов и экзаменов: " + data.progress.tests),
        element("p", "Верных ответов: " + data.progress.correct), actionLink("RPM Training", "/training")),
      card("Избранные нормы", rows(norms), actionLink("Открыть избранное", "/?tab=favorites")));
    grid.append(left, right);
    container.replaceChildren(hero, metrics, card("Быстрые действия", actions), grid);
    if (data.announcements.length) {
      const notices = element("ul", "", { class: "personal-results" });
      notices.append(...data.announcements.map(item => element("li", item.title)));
      container.append(card("Объявления", notices));
    }
  } catch (error) { container.replaceChildren(element("p", error.message, { role: "status" })); }
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

export function openView(_url, tab) {
  if (tab === "dashboard") return dashboard(byId("personalDashboard"));
  if (tab === "calendar") return calendar(byId("personalCalendar"));
  if (tab === "favorites") return showFavorites(byId("personalFavorites"));
}
