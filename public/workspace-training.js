import { byId, element, request, sourceLink } from "./workspace-common.js";

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
  byId("topics").replaceChildren(...Object.entries(data.topics).map(([reference, topic]) =>
    element("li", `${reference} · ${topic.incorrect ? "Повторить" : "Изучено"} · ${topic.correct} верно, ${topic.incorrect} ошибок`)));
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
  byId("prompt").textContent = mode === "quiz" || mode === "exam"
    ? `Выберите точный текст нормы\n${question.prompt}` : question.prompt;
  choices.replaceChildren();
  feedback.replaceChildren();
  if (mode === "cards") {
    addButton(choices, "Показать содержание", () => {
      choices.replaceChildren(element("p", question.text, { class: "source" }));
      addButton(choices, "Знаю", () => answer("known"));
      addButton(choices, "Повторить", () => answer("repeat"));
    });
  } else {
    question.choices.forEach((choice, position) => addButton(choices, choice, () => answer(position), "secondary option"));
  }
}

async function answer(value) {
  const buttons = [...choices.querySelectorAll("button")];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const data = await request(`/api/training/attempts/${attempt.id}/answers`, "POST", { index, answer: value });
    byId("trainingProgress").value = index + 1;
    feedback.replaceChildren(
      element("h3", mode === "cards" ? (data.correct ? "Отмечено как изученное" : "Отмечено для повторения")
        : data.correct ? "Верно" : "Ошибка в выборе нормы"),
      element("a", data.reference, { href: sourceLink(data.documentId, data.anchor) }),
      element("p", data.text, { class: "source" }),
      element("p", data.explanation)
    );
    if (data.result) {
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
export async function openView() {
  if (initialized) return selectFromLink();
  if (loading) return;
  loading = true;
  status.textContent = "Загрузка данных обучения…";
  byId("retryTraining").hidden = true;
  try {
    documents = await request("/api/documents");
    refreshDocuments();
    selectFromLink();
    await loadProgress();
    initialized = true;
    status.textContent = "";
  } catch (error) {
    status.textContent = error.message;
    byId("retryTraining").hidden = false;
  } finally { loading = false; }
}
byId("retryTraining").addEventListener("click", openView);
