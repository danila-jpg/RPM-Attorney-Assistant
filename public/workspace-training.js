import { byId, element, request, sourceLink } from "./workspace-common.js";

import { favoriteControl } from "./workspace-personal.js";

const form = byId("setup");
const fields = form.elements;
const status = byId("trainingStatus");
const choices = byId("choices");
const feedback = byId("feedback");
let documents = [];
let initialized = false;
let loading = false;
const selectedIds = new Set();
let attempt, index, mode;

function refreshDocuments() {
  const laws = fields.category.value === "law";
  byId("organization").hidden = laws;
  const filtered = documents.filter(doc => laws === (doc.type === "law"));
  const previous = fields.organization.value;
  const orgs = [...new Set(filtered.map(doc => doc.organization).filter(Boolean))];
  fields.organization.replaceChildren(element("option", "Все организации", { value: "" }), ...orgs.map(org => element("option", org, { value: org })));
  if (orgs.includes(previous)) fields.organization.value = previous;
  const selected = fields.organization.value;
  const query = fields.documentSearch.value.trim().toLowerCase();
  fields.documents.replaceChildren(...filtered.filter(doc => (laws || !selected || doc.organization === selected) && doc.name.toLowerCase().includes(query))
    .map(doc => element("option", doc.name, { value: doc.id })));
  if (fields.documents.options.length) fields.documents.options[0].selected = true;
  refreshStudy();
}

function renderSelection() {
  byId("selectedTrainingDocuments").replaceChildren(...[...selectedIds].map(id => {
    const item = element("li", documents.find(doc => doc.id === id).name);
    addButton(item, "Убрать", () => { selectedIds.delete(id); renderSelection(); });
    return item;
  }));
}

function refreshStudy() {
  byId("study").hidden = !fields.documents.value;
  byId("study").href = sourceLink(fields.documents.value);
}

async function loadProgress() {
  const data = await request("/api/training/progress");
  byId("summary").textContent = `Тестов: ${data.tests}. Правильных ответов: ${data.correct}. Ошибок: ${data.incorrect}. Лучший результат: ${data.best == null ? "—" : data.best + "%"}. Последнее занятие: ${data.lastTraining ? new Date(data.lastTraining).toLocaleString("ru") : "—"}.`;
  byId("topics").replaceChildren(...Object.entries(data.topics).filter(([, topic]) => topic.incorrect).sort((a, b) => b[1].incorrect - a[1].incorrect).map(([reference, topic]) =>
    element("li", `${reference} · ${topic.correct} верно, ${topic.incorrect} ошибок`)));
  byId("trainingDocumentsStats").replaceChildren(...Object.values(data.documents).map(doc =>
    element("li", `${doc.name} · ${doc.correct} верно, ${doc.incorrect} ошибок`)));
  byId("trainingHistory").replaceChildren(...data.history.map(result => {
    const item = element("li");
    item.append(element("a", `${new Date(result.at).toLocaleString("ru")} · ${result.percent}%`,
      { href: "/training?review=" + result.id }));
    return item;
  }));
}

function addButton(parent, text, handler, className = "secondary") {
  const control = element("button", text, { type: "button", class: className });
  control.addEventListener("click", handler);
  parent.append(control);
}

function showQuestion() {
  const question = attempt.questions[index];
  byId("trainingProgress").max = attempt.questions.length;
  byId("trainingProgress").value = index;
  byId("position").textContent = `${index + 1} из ${attempt.questions.length}`;
  byId("prompt").textContent = question.prompt;
  choices.replaceChildren();
  feedback.replaceChildren();
  if (mode === "cards") {
    addButton(choices, "Показать содержание", () => {
      choices.replaceChildren(element("p", question.text, { class: "source" }));
      addButton(choices, "Знаю", () => answer("known"));
      addButton(choices, "Повторить", () => answer("repeat"));
    });
  } else if (question.type === "multiple") {
    const selected = new Set();
    question.choices.forEach((choice, position) => addButton(choices, choice, event => {
      if (selected.has(position)) selected.delete(position); else selected.add(position);
      event.currentTarget.setAttribute("aria-pressed", String(selected.has(position)));
      confirm.disabled = !selected.size;
    }, "secondary option"));
    addButton(choices, "Подтвердить выбор", () => answer([...selected]), "primary");
    const confirm = choices.lastElementChild;
    confirm.disabled = true;
  } else {
    question.choices.forEach((choice, position) => addButton(choices, choice, () => answer(position), "secondary option"));
  }
}

function renderReview(parent, data) {
  parent.append(element("h3", data.correct ? "Верно" : "Ошибка"),
    element("p", data.reference + " · " + data.revision),
    element("a", "Открыть пункт в уставе", { href: sourceLink(data.documentId, data.anchor) }),
    element("p", data.text, { class: "source" }), element("p", data.explanation));
}

async function answer(value) {
  const buttons = [...choices.querySelectorAll("button")];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const data = await request(`/api/training/attempts/${attempt.id}/answers`, "POST", { index, answer: value });
    byId("trainingProgress").value = index + 1;
    feedback.replaceChildren();
    const positions = value => (Array.isArray(value) ? value : [value]).filter(Number.isInteger);
    const selected = positions(data.selected);
    const correct = positions(data.correctChoice);
    selected.forEach(position => buttons[position]?.setAttribute("aria-pressed", "true"));
    correct.forEach(position => buttons[position]?.classList.add("option-correct"));
    if (data.correct === false) selected.filter(position => !correct.includes(position))
      .forEach(position => buttons[position]?.classList.add("option-incorrect"));
    if (data.reference) renderReview(feedback, data);
    else feedback.append(element("p", "Ответ сохранён."));
    if (data.result) {
      feedback.append(element("a", "Открыть разбор и избранное", { href: "/training?review=" + attempt.id }));
      if (mode === "exam") {
        const review = element("details");
        review.append(element("summary", "Разбор экзамена"));
        data.result.review.forEach((item, position) => {
          const section = element("section");
          const question = attempt.questions[position];
          section.append(element("p", question.prompt), element("p", "Ваш ответ — " + question.choices[item.selected]),
            element("p", "Правильный ответ — " + question.choices[item.correctChoice]));
          renderReview(section, item);
          review.append(section);
        });
        feedback.append(review);
      }
      feedback.append(element("h3", `Результат: ${data.result.percent}%`));
      if (data.result.wrong.length) {
        feedback.append(element("p", "Повторите следующие нормы."));
        const list = element("ul");
        for (const error of data.result.wrong) {
          const item = element("li");
          item.append(element("a", error.reference, { href: sourceLink(error.documentId, error.anchor) }));
          list.append(item);
        }
        feedback.append(list);
        addButton(feedback, "Повторить ошибки", async event => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            attempt = await request(`/api/training/attempts/${attempt.id}/retry`, "POST");
            index = 0;
            showQuestion();
          } catch (error) {
            feedback.append(element("p", error.message, { role: "status" }));
            button.disabled = false;
          }
        });
      }
    } else {
      addButton(feedback, "Дальше", () => { index++; showQuestion(); }, "primary");
    }
    loadProgress().catch(error => { byId("summary").textContent = error.message; });
  } catch (error) {
    feedback.textContent = error.message;
    buttons.forEach(button => { button.disabled = false; });
  }
}

fields.category.addEventListener("change", refreshDocuments);
fields.organization.addEventListener("change", refreshDocuments);
fields.documents.addEventListener("change", refreshStudy);
fields.documentSearch.addEventListener("input", refreshDocuments);
byId("addTrainingDocument").addEventListener("click", () => {
  if (fields.documents.value) selectedIds.add(fields.documents.value);
  renderSelection();
});
form.addEventListener("submit", async event => {
  event.preventDefault();
  const start = form.querySelector("button.primary");
  start.disabled = true;
  status.textContent = "Подготовка вопросов…";
  byId("exercise").hidden = true;
  try {
    mode = fields.mode.value;
    attempt = await request("/api/training/attempts", "POST", {
      mode, size: Number(fields.size.value), documentIds: selectedIds.size ? [...selectedIds] : [fields.documents.value].filter(Boolean)
    });
    index = 0;
    byId("resumeTraining").hidden = true;
    status.textContent = "";
    byId("exercise").hidden = false;
    showQuestion();
  } catch (error) { status.textContent = error.message; }
  finally { start.disabled = false; }
});
function selectFromLink() {
  const id = new URL(location.href).searchParams.get("doc");
  const doc = documents.find(item => item.id === id);
  if (!doc || selectedIds.has(id)) return;
  selectedIds.clear();
  selectedIds.add(id);
  fields.category.value = doc.type === "law" ? "law" : "charters";
  fields.organization.value = "";
  fields.documentSearch.value = "";
  refreshDocuments();
  fields.documents.value = id;
  refreshStudy();
  renderSelection();
}
async function showCompleted(id, fragment) {
  const completed = await request("/api/training/attempts/" + encodeURIComponent(id) + "/review");
  const exercise = byId("exercise");
  exercise.hidden = false;
  const count = completed.questions.length;
  const correct = Object.values(completed.answers).filter(answer => answer.correct).length;
  byId("position").textContent = "Результат: " + Math.round(100 * correct / count) + "%";
  byId("trainingProgress").max = count;
  byId("trainingProgress").value = count;
  byId("prompt").textContent = "";
  choices.replaceChildren();
  feedback.replaceChildren();
  completed.questions.forEach((question, index) => {
    const checked = completed.answers[index];
    const item = element("details");
    item.open = fragment === "#" + index;
    item.append(element("summary", (index + 1) + ". " + question.prompt));
    const format = value => Array.isArray(value) ? value.map(position => question.choices[position]).join(" · ") : question.choices[value] || value;
    if (question.choices.length) item.append(element("p", "Ваш ответ — " + format(checked.answer)),
      element("p", "Правильный ответ — " + format(question.correct)));
    renderReview(item, { ...question, correct: checked.correct });
    const favoriteStatus = element("span", "", { role: "status" });
    item.append(favoriteControl("question", id + ":" + index, favoriteStatus), favoriteStatus);
    feedback.append(item);
  });
  if (correct < count) addButton(feedback, "Повторить ошибки", async event => {
    const control = event.currentTarget;
    control.disabled = true;
    try {
      attempt = await request("/api/training/attempts/" + encodeURIComponent(id) + "/retry", "POST");
      mode = attempt.mode;
      index = 0;
      showQuestion();
    } catch (error) { status.textContent = error.message; control.disabled = false; }
  });
}

export async function openView(url = new URL(location.href)) {
  const review = url.searchParams.get("review");
  if (review) {
    try { await showCompleted(review, url.hash); }
    catch (error) { status.textContent = error.message; }
  }
  if (initialized) return selectFromLink();
  if (loading) return;
  loading = true;
  status.textContent = "Загрузка данных обучения…";
  byId("retryTraining").hidden = true;
  try {
    documents = await request("/api/documents");
    refreshDocuments();
    selectFromLink();
    const current = await request("/api/training/attempts/current");
    if (current) {
      const resume = byId("resumeTraining");
      resume.hidden = false;
      resume.onclick = () => {
        attempt = current;
        mode = current.mode;
        index = current.index;
        byId("exercise").hidden = false;
        resume.hidden = true;
        showQuestion();
      };
    }
    await loadProgress();
    initialized = true;
    status.textContent = "";
  } catch (error) {
    status.textContent = error.message;
    byId("retryTraining").hidden = false;
  } finally { loading = false; }
}
byId("retryTraining").addEventListener("click", openView);
