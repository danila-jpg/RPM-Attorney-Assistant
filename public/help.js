import { articles, faq, tour } from "./help-content.js";
import { byId, element, request } from "./workspace-common.js";

const articleMap = new Map(articles.map(article => [article.id, article]));
const urlFor = id => id ? "/?tab=help&article=" + id : "/?tab=help";
const button = (text, action, attrs) => {
  const control = element("button", text, { type: "button", class: "secondary", ...attrs });
  control.addEventListener("click", action);
  return control;
};
const link = (text, href, attrs) => element("a", text, { href, ...attrs });
const endpoint = "/api/workspace/help";
const main = byId("helpResults");
const search = byId("helpSearch");
const count = byId("helpSearchStatus");
const dialog = byId("helpDialog");
const quick = byId("helpQuick");
const state = { progress: null, votes: {} };
const watchedTopics = new Set();
let ready = false;
let trackingTimer;
let highlighted;
let running = false;
let saving = false;
let returnTo;
let role;

const support = () => role?.isCustomer
  ? "/app/account.html#supportSection"
  : role?.isAdmin ? "/?tab=support" : "/app/account.html#supportSection";
const route = id => window.rpmNavigate(urlFor(id));
const normalize = text => text.toLocaleLowerCase("ru").replaceAll("ё", "е");
const tokensFor = value => [...new Set(normalize(value).match(/[\p{L}\p{N}]+/gu)?.filter(word => word.length > 1) ?? [])].slice(0, 8);

const related = {
  start: ["analysis", "live", "laws"], analysis: ["history", "police", "laws"],
  police: ["questions", "analysis", "laws"], questions: ["police", "live"],
  live: ["voice", "compact"], voice: ["live", "compact", "troubleshooting"],
  compact: ["live", "voice"], reference: ["laws", "training"], laws: ["documents", "reference"],
  training: ["laws", "reference"], clients: ["history", "calendar"], history: ["analysis", "clients"],
  documents: ["laws", "analysis"], calendar: ["history", "clients"], subscription: ["account", "troubleshooting"],
  account: ["subscription", "troubleshooting"], troubleshooting: ["voice", "account", "live"]
};
const screenshots = {
  start: "Название текущего раздела над рабочей областью",
  analysis: "Поле описания обстоятельств в форме анализа дела",
  police: "Кнопка запуска проверки действий полиции",
  questions: "Поле предполагаемой статьи в форме проверки ответов",
  live: "Кнопка «Получить подсказку» в Live Assistant",
  voice: "Кнопка «Проверить микрофон» в настройках",
  compact: "Флажок «Компактно» в окне Live Assistant",
  reference: "Поле вопроса в справочнике адвоката",
  laws: "Поиск в разделе «Все законы»",
  training: "Режимы занятий в RPM Training",
  clients: "Кнопка «Добавить клиента»",
  history: "Поиск сохранённых дел",
  documents: "Фильтр библиотеки документов",
  calendar: "Создание события в календаре",
  subscription: "Выбор тарифа в форме продления лицензии",
  account: "Кнопка сохранения настроек профиля",
  troubleshooting: "Кнопка создания обращения в поддержку"
};
const exercises = {
  analysis: ["Как отметить сведения, которых пока нет?", "Указать, что неизвестно", "Дополнить догадкой",
    "Верно. Так помощник сможет отразить пробел и предложить уточнение.", "Если предположение важно, явно пометьте его. В хронологии отделите его от наблюдений."],
  police: ["Запись начинается после остановки. Что указать?", "Отметить границы записи", "Назвать запись полной",
    "Верно. Укажите, какие действия попали в кадр и что известно со слов участников.", "Запишите время начала видео. Действия до этой отметки требуют других источников."],
  questions: ["Сотрудник оставил вопрос без ответа. Что вписать?", "Оставить этот ответ пустым", "Записать предполагаемый ответ",
    "Верно. Можно добавить контекст разговора в отдельное поле.", "Сохраните различие между репликой сотрудника и предположением."],
  live: ["Для сцены нужна одна короткая реплика. Какой режим выбрать?", "Мгновенная подсказка", "Полный анализ",
    "Верно. Укажите задачу одной фразой и проверьте готовую реплику.", "Полный анализ подходит для подробного разбора. Для одной реплики выберите мгновенный режим."],
  voice: ["Диктовка пропустила «не». Как поступить?", "Исправить текст перед запросом", "Отправить распознанный текст",
    "Верно. Поправьте текст в поле Live Assistant.", "Пропуск меняет смысл. Сначала исправьте и перечитайте фразу."]
};

function updateTourButton() {
  byId("helpTour").textContent = state.progress?.status === "active" ? "Продолжить обучение" : "Пройти обучение";
}

function marked(node, text, words) {
  if (!words.length) {
    node.textContent = text;
    return;
  }
  const regex = new RegExp(words.map(word => word.replace(/е/g, "[её]")).join("|"), "giu");
  let start = 0;
  for (const match of text.matchAll(regex)) {
    node.append(text.slice(start, match.index), element("mark", match[0]));
    start = match.index + match[0].length;
  }
  node.append(text.slice(start));
}

function matching(words) {
  const candidates = [
    ...articles.map(article => ({ ...article, excerpt: article.purpose, extra: [article.terms, article.steps, article.interpretation, article.pitfall, article.example].join(" ") })),
    ...faq.map(([title, excerpt, topic], i) => ({ id: "faq#" + (i + 1), topic, title, excerpt, icon: "?", extra: "" }))
  ];
  return candidates.map(item => {
    const fields = [item.title, item.excerpt, item.extra].map(normalize);
    const weights = words.map(word => fields.reduce((score, field, i) => score + (field.includes(word) ? 3 - i : 0), 0));
    return { ...item, score: weights.every(Boolean) ? weights.reduce((a, b) => a + b, 0) : 0 };
  }).filter(item => !words.length || item.score).sort((a, b) => b.score - a.score);
}

function render(id) {
  main.replaceChildren();
  count.textContent = "";
  document.querySelectorAll("#helpCategories a").forEach(anchor => {
    if (anchor.dataset.article === id) anchor.setAttribute("aria-current", "page");
    else anchor.removeAttribute("aria-current");
  });
  if (articleMap.has(id)) return renderArticle(articleMap.get(id));
  if (id === "faq") return renderFaq();
  const words = tokensFor(search.value);
  const results = matching(words);
  if (words.length) count.textContent = results.length ? "Найдено материалов — " + results.length : "Совпадений нет. Попробуйте «микрофон» или «сохранить дело».";
  const grid = element("div", null, { class: "help-grid" });
  for (const item of words.length ? results : results.filter(item => !item.topic)) {
    const [page, question] = item.id.split("#");
    const card = link("", urlFor(page) + (question ? "#faq-" + question : ""), { class: "help-card" });
    const title = element("strong");
    const excerpt = element("p");
    marked(title, item.title, words);
    marked(excerpt, item.excerpt, words);
    if (words.length && !title.querySelector("mark") && !excerpt.querySelector("mark")) {
      const match = item.extra.split(/(?<=[.!?])\s+/).find(fragment => words.some(word => normalize(fragment).includes(word)));
      if (match) marked(excerpt, match, words);
    }
    card.append(element("span", item.icon, { "aria-hidden": "true" }), title, excerpt);
    grid.append(card);
  }
  main.append(grid);
}

function renderFaq() {
  const page = element("article", null, { class: "help-article" });
  page.append(element("h2", "Часто задаваемые вопросы"));
  for (const [i, [question, answer, id]] of faq.entries()) {
    const details = element("details", null, { id: "faq-" + (i + 1) });
    details.open = location.hash === "#" + details.id;
    details.append(element("summary", question), element("p", answer), link("Читать инструкцию", urlFor(id)));
    page.append(details);
  }
  page.append(link("Обратиться в поддержку", support()));
  main.append(page);
}

function renderArticle(article) {
  const page = element("article", null, { class: "help-article" });
  page.append(element("h2", article.title), element("p", article.purpose));
  if (article.id === "live") {
    const shortcuts = element("div", null, { class: "help-actions" });
    shortcuts.append(link("Настройка микрофона и диктовка", urlFor("voice")), link("Компактно и поверх окон", urlFor("compact")));
    page.append(shortcuts);
  }
  page.append(element("h3", "Порядок работы"));
  const steps = element("ol");
  for (const step of article.steps.split(/(?<=\.)\s+/)) steps.append(element("li", step));
  page.append(steps);
  const caption = screenshots[article.id];
  const figure = element("figure");
  figure.append(element("img", null, { src: "/help-images/" + article.id + ".png", alt: caption, loading: "lazy" }), element("figcaption", caption));
  page.append(figure);
  for (const [title, text] of [["Как понимать результат", article.interpretation], ["Частые ошибки", article.pitfall]]) {
    page.append(element("h3", title), element("p", text));
  }
  const example = element("details");
  example.append(element("summary", "Разобрать пример из RP"), element("p", article.example), link("Открыть инструмент", toolUrl(article)));
  if (exercises[article.id]) {
    const [question, correct, alternative, correctFeedback, alternativeFeedback] = exercises[article.id];
    example.append(element("p", question));
    const result = element("p", "", { role: "status" });
    const actions = element("div", null, { class: "help-actions" });
    actions.append(
      button(correct, () => { result.textContent = correctFeedback; }),
      button(alternative, () => { result.textContent = alternativeFeedback; })
    );
    example.append(actions, result);
  }
  const links = element("div", null, { class: "help-actions" });
  links.append(...related[article.id].map(id => link(articleMap.get(id).title, urlFor(id))), link("FAQ", urlFor("faq")));
  page.append(example, element("h3", "Связанные инструкции"), links);
  const vote = element("div", null, { class: "help-actions" });
  const status = element("p", "", { role: "status" });
  const supportLink = link("Проблема осталась? Обратиться в поддержку", support());
  const choices = [true, false].map(helpful => button(helpful ? "Да" : "Нет", async () => {
    choices.forEach(choice => { choice.disabled = true; });
    try {
      await request(endpoint + "/vote", "PUT", { article: article.id, helpful });
      state.votes[article.id] = helpful;
      sync();
      status.textContent = "Спасибо за оценку.";
    } catch {
      status.textContent = "Не удалось сохранить оценку. Повторите попытку после входа.";
    } finally {
      choices.forEach(choice => { choice.disabled = false; });
    }
  }));
  function sync() {
    choices.forEach((choice, i) => choice.setAttribute("aria-pressed", String(state.votes[article.id] === (i === 0))));
  }
  sync();
  vote.append(element("strong", "Была ли эта статья полезной?"), ...choices);
  page.append(vote, status, supportLink);
  main.append(page);
}

function toolUrl(article) {
  if (article.id === "account" && role?.isAdmin) return "/admin#profile";
  return article.href;
}

function activeArticle() {
  return new URLSearchParams(location.search).get("article");
}

function submitSearch() {
  const words = tokensFor(search.value);
  if (!words.length || !ready) return;
  const match = matching(words)[0];
  const topic = match?.topic ?? match?.id;
  if (!topic || watchedTopics.has(topic)) return;
  watchedTopics.add(topic);
  request(endpoint + "/search", "POST", { topic }).catch(() => watchedTopics.delete(topic));
}

search.addEventListener("input", () => {
  if (activeArticle()) route(null);
  else render(null);
  clearTimeout(trackingTimer);
  trackingTimer = setTimeout(submitSearch, 800);
});
byId("helpSearchForm").addEventListener("submit", event => {
  event.preventDefault();
  submitSearch();
});
for (const article of [...articles, { id: "faq", title: "Частые вопросы" }]) {
  byId("helpCategories").append(link(article.title, urlFor(article.id), { "data-article": article.id }));
}
const categoryMenu = byId("helpCategories").closest("details");
const narrow = matchMedia("(max-width: 700px)");
if (narrow.matches) categoryMenu.open = false;
categoryMenu.addEventListener("click", event => {
  if (narrow.matches && event.target.closest("a")) categoryMenu.open = false;
});

function moveSpotlight(selector) {
  highlighted?.classList.remove("help-highlight");
  highlighted = document.querySelector(selector);
  highlighted?.classList.add("help-highlight");
  highlighted?.scrollIntoView({ block: "center", inline: "nearest" });
}

function closeTour(restore = false) {
  running = false;
  highlighted?.classList.remove("help-highlight");
  highlighted = null;
  dialog.close();
  if (restore && returnTo) window.rpmNavigate(returnTo);
}

async function progress(step, status) {
  if (saving) return false;
  saving = true;
  const controls = [...dialog.querySelectorAll("button:not(:disabled)")];
  controls.forEach(control => { control.disabled = true; });
  try {
    state.progress = await request(endpoint + "/tour", "PUT", { step, status });
    updateTourButton();
    return true;
  } catch {
    byId("helpDialogStatus").textContent = "Не удалось сохранить прогресс. Повторите попытку.";
    return false;
  } finally {
    controls.forEach(control => { control.disabled = false; });
    saving = false;
  }
}

function setTourContent(title, description, controls) {
  byId("helpDialogTitle").textContent = title;
  byId("helpDialogText").textContent = description;
  byId("helpDialogStatus").textContent = "";
  byId("helpDialogActions").replaceChildren(...controls);
}

function showStep(index) {
  const [selector, title, description, tab] = tour[index];
  running = true;
  if (dialog.open) dialog.close();
  dialog.setAttribute("data-running", "");
  window.rpmNavigate("/?tab=" + tab);
  setTourContent(title, (index + 1) + " из " + tour.length + ". " + description, [
    button("Назад", async () => { if (await progress(index - 1, "active")) showStep(index - 1); }, index === 0 ? { disabled: "" } : {}),
    button(index + 1 === tour.length ? "Завершить обучение" : "Далее", async () => {
      if (index + 1 === tour.length) {
        if (await progress(index, "completed")) closeTour(true);
      } else if (await progress(index + 1, "active")) showStep(index + 1);
    }),
    button("Пропустить", async () => { if (await progress(index, "skipped")) closeTour(true); })
  ]);
  dialog.show();
  moveSpotlight(selector);
}

async function begin(index = 0) {
  returnTo = location.href;
  if (await progress(index, "active")) showStep(index);
}

function offer() {
  if (dialog.open || document.querySelector("dialog[open]") || location.hash === "#live") return;
  dialog.removeAttribute("data-running");
  setTourContent("Познакомьтесь с помощником", "Пять коротких шагов покажут, где начать анализ, открыть Live Assistant и найти источники.", [
    button("Начать обучение", () => begin()),
    button("Пропустить", async () => { if (await progress(0, "skipped")) closeTour(); })
  ]);
  dialog.showModal();
}

dialog.addEventListener("cancel", event => {
  event.preventDefault();
  if (running) closeTour(true);
  else dialog.querySelector("button:last-of-type")?.click();
});
byId("helpTour").addEventListener("click", async () => {
  if (!ready) await load();
  if (!ready) {
    count.textContent = "Войдите в аккаунт и попробуйте снова, чтобы сохранять прогресс.";
    return;
  }
  dialog.removeAttribute("data-running");
  setTourContent("Интерактивное обучение", "Пройдите основные шаги с подсказками на экране.", [
    button(state.progress?.status === "active" ? "Продолжить" : "Начать", () => begin(state.progress?.status === "active" ? state.progress.step : 0)),
    button("Закрыть", () => closeTour())
  ]);
  if (!dialog.open) dialog.showModal();
});

function addQuickHelp(selector, id) {
  const heading = document.querySelector(selector);
  if (!heading) return;
  const article = articleMap.get(id);
  const control = button("?", () => {
    quick.querySelector("h2").textContent = article.title;
    quick.querySelector("p").textContent = article.steps;
    quick.querySelector("a").href = urlFor(id);
    quick.showModal();
  }, { class: "help-question", "aria-label": "Справка — " + article.title, "aria-haspopup": "dialog" });
  heading.append(" ", control);
}

for (const [selector, id] of [
  ["#analysis h1", "analysis"], ["#police h1", "police"],
  ["#questions h1", "questions"], ["#reference h1", "reference"], ["#laws h1", "laws"],
  ["#training h1", "training"], ["#clients h1", "clients"], ["#history h1", "history"],
  ["#charters h1", "documents"], ["#calendar h1", "calendar"], ["#liveTitle", "live"],
  ["#liveSettingsTitle", "voice"]
]) addQuickHelp(selector, id);
quick.querySelector("button").addEventListener("click", () => quick.close());
quick.querySelector("a").addEventListener("click", event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  quick.close();
  byId("liveSettings")?.close?.();
  byId("liveDialog")?.close();
});

function hint(selector, id, text) {
  const control = document.querySelector(selector);
  if (!control) return;
  const note = element("small", text, { id, class: "help-muted" });
  const references = [control.getAttribute("aria-describedby"), id].filter(Boolean).join(" ");
  control.setAttribute("aria-describedby", references);
  control.after(note);
}
hint("#caseDescription", "helpCaseFacts", "Укажите время, порядок действий и источник каждого спорного факта.");
hint("#policeDescription", "helpPoliceFacts", "Перечислите действия сотрудника по порядку. Отметьте, что подтверждено записью.");
hint("#suspectedArticle", "helpSuspectedArticle", "Если номер статьи неизвестен, оставьте поле пустым.");
hint("#liveMode", "helpLiveMode", "Мгновенная подсказка подходит, когда нужна короткая реплика.");
hint("#liveEngine", "helpLiveEngine", "При ошибках автоматического выбора попробуйте доступный режим вручную.");

let pending;
function load() {
  if (pending) return pending;
  pending = Promise.all([request(endpoint), request("/api/panel/permissions")]).then(([data, permissions]) => {
    Object.assign(state, data);
    role = permissions;
    ready = true;
    updateTourButton();
    if (byId("help").classList.contains("active")) render(activeArticle());
    if (state.offer && !state.progress) {
      const url = new URL(location.href);
      if (url.searchParams.get("tour") === "1") {
        url.searchParams.delete("tour");
        history.replaceState(null, "", url);
        if (byId("help").classList.contains("active")) void begin().then(() => { if (!running) offer(); });
      } else offer();
    }
  }).catch(() => {}).finally(() => { pending = null; });
  return pending;
}

window.addEventListener("rpm-route", ({ detail: { tab } }) => {
  if (tab === "help") render(activeArticle());
  if (location.hash === "#live" && !byId("liveDialog").open) byId("liveOpen").click();
});
if (byId("help").classList.contains("active")) render(activeArticle());
void load();
