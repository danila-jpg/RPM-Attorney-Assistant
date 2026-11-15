
from pathlib import Path
from datetime import datetime
import shutil

PROJECT = Path(r"F:\RPM_Attorney_Assistant1")
PUBLIC = PROJECT / "public"
INDEX = PUBLIC / "index.html"

if not PROJECT.exists():
    raise SystemExit(f"Папка проекта не найдена: {PROJECT}")

PUBLIC.mkdir(exist_ok=True)

# Создаём резервную копию старой страницы
if INDEX.exists():
    backup = PUBLIC / f"index_backup_{datetime.now():%Y%m%d_%H%M%S}.html"
    shutil.copy2(INDEX, backup)
    print(f"Резервная копия: {backup}")

html = r'''<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RPM Attorney Assistant</title>

<style>
:root {
  --bg: #090711;
  --panel: #151121;
  --panel2: #1e1830;
  --border: #35264d;
  --purple: #9865ed;
  --purple2: #7044bd;
  --text: #f1eafa;
  --muted: #a99bbd;
  --red: #ed647b;
  --green: #62d6a0;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: Segoe UI, Arial, sans-serif;
}

header {
  padding: 22px 30px;
  background: linear-gradient(120deg, #1b1230, #100d1b);
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 15px;
  flex-wrap: wrap;
}

.logo {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: .5px;
}

.logo span { color: var(--purple); }

.status {
  color: var(--muted);
  font-size: 13px;
}

.status strong { color: var(--green); }

nav {
  display: flex;
  gap: 8px;
  padding: 15px 25px;
  background: #100d19;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}

nav button {
  white-space: nowrap;
  background: transparent;
  color: var(--muted);
  border: 1px solid transparent;
  padding: 11px 15px;
  border-radius: 9px;
  cursor: pointer;
  font-size: 14px;
}

nav button:hover,
nav button.active {
  color: white;
  background: #291d40;
  border-color: #67439a;
}

main {
  max-width: 1250px;
  margin: 25px auto;
  padding: 0 20px 50px;
}

.tab { display: none; }
.tab.active { display: block; }

h1 { font-size: 25px; margin: 0 0 8px; }
h2 { font-size: 19px; margin-top: 0; }
.subtitle { color: var(--muted); margin-bottom: 23px; }

.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 13px;
  padding: 21px;
  margin-bottom: 17px;
}

label {
  display: block;
  margin: 14px 0 7px;
  color: #d9cbea;
  font-size: 14px;
}

input, textarea, select {
  width: 100%;
  background: #0e0b17;
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 8px;
  padding: 12px;
  outline: none;
  font: inherit;
}

input:focus, textarea:focus, select:focus {
  border-color: var(--purple);
}

textarea {
  min-height: 130px;
  resize: vertical;
  line-height: 1.5;
}

button.primary {
  background: linear-gradient(120deg, var(--purple2), var(--purple));
  color: white;
  border: 0;
  border-radius: 8px;
  padding: 12px 18px;
  margin-top: 14px;
  cursor: pointer;
  font-weight: 650;
}

button.primary:hover { filter: brightness(1.13); }

button.secondary {
  background: #292039;
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 8px;
  padding: 10px 14px;
  cursor: pointer;
  margin: 5px 5px 0 0;
}

button.danger {
  background: #3b1926;
  border: 1px solid #773044;
  color: #ffb5c1;
  border-radius: 8px;
  padding: 9px 12px;
  cursor: pointer;
}

button:disabled { opacity: .5; cursor: wait; }

.result {
  margin-top: 20px;
  padding: 18px;
  border-radius: 10px;
  background: #100d19;
  border: 1px solid var(--border);
  white-space: pre-wrap;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.hidden { display: none !important; }

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 15px;
}

.case-item, .law-item {
  background: var(--panel2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 15px;
  margin: 10px 0;
}

.case-item h3, .law-item h3 { margin: 0 0 8px; }

.muted { color: var(--muted); font-size: 13px; }

pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

#toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  background: #281d3d;
  border: 1px solid var(--purple);
  padding: 13px 18px;
  border-radius: 9px;
  display: none;
  max-width: 90%;
  z-index: 10;
}

@media(max-width: 700px) {
  header { padding: 18px; }
  nav { padding: 10px; }
  main { padding: 0 12px 35px; }
  .grid { grid-template-columns: 1fr; }
  .panel { padding: 15px; }
}
</style>
</head>

<body>

<header>
  <div class="logo">RPM <span>ATTORNEY ASSISTANT</span></div>
  <div class="status" id="systemStatus">Проверка подключения...</div>
</header>

<nav>
  <button class="active" data-tab="analysis">Анализ дела</button>
  <button data-tab="questions">Вопросы сотруднику</button>
  <button data-tab="reference">Справочник адвоката</button>
  <button data-tab="history">История дел</button>
  <button data-tab="laws">Все законы</button>
</nav>

<main>

<section id="analysis" class="tab active">
  <h1>Анализ дела</h1>
  <p class="subtitle">Правовой анализ ситуации на основании загруженного законодательства RPM.</p>

  <div class="panel">
    <label>Название дела</label>
    <input id="caseTitle" placeholder="Например: Незаконное задержание">

    <label>Описание ситуации и установленные факты</label>
    <textarea id="caseDescription" placeholder="Опишите ситуацию, действия участников, последовательность событий и имеющиеся доказательства..."></textarea>

    <label>Дополнительные материалы и доказательства</label>
    <textarea id="caseEvidence" placeholder="Видео, показания, документы, переписка и другие материалы..."></textarea>

    <button class="primary" onclick="runAI('analyze')">Провести анализ</button>
    <div id="analysisResult" class="result hidden"></div>
    <div class="toolbar">
      <button class="secondary" onclick="saveCurrentCase()">Сохранить дело</button>
    </div>
  </div>

  <div class="panel">
    <h2>Оценка ответа сотрудника</h2>
    <label>Ответ сотрудника</label>
    <textarea id="officerAnswer" placeholder="Вставьте ответ сотрудника полиции или государственного органа..."></textarea>
    <button class="primary" onclick="runAI('evaluate_answer')">Оценить ответ</button>
    <div id="evaluationResult" class="result hidden"></div>
  </div>

  <div class="panel">
    <h2>Уточняющие вопросы</h2>
    <button class="primary" onclick="runAI('followup')">Сформировать уточняющие вопросы</button>
    <div id="followupResult" class="result hidden"></div>
  </div>
</section>

<section id="questions" class="tab">
  <h1>Вопросы сотруднику</h1>
  <p class="subtitle">ИИ подготовит вопросы с учётом обстоятельств дела и законодательства RPM.</p>
  <div class="panel">
    <label>Контекст ситуации</label>
    <textarea id="questionsContext" placeholder="Опишите ситуацию, в рамках которой нужно задать вопросы сотруднику..."></textarea>
    <button class="primary" onclick="runAI('questions')">Сформировать вопросы</button>
    <div id="questionsResult" class="result hidden"></div>
  </div>
</section>

<section id="reference" class="tab">
  <h1>Справочник адвоката</h1>
  <p class="subtitle">Поиск правовой информации в загруженных документах RPM.</p>
  <div class="panel">
    <label>Ваш вопрос</label>
    <textarea id="referenceQuestion" placeholder="Например: Какие основания предусмотрены для задержания гражданина?"></textarea>
    <button class="primary" onclick="runAI('reference')">Получить ответ</button>
    <div id="referenceResult" class="result hidden"></div>
  </div>
</section>

<section id="history" class="tab">
  <h1>История дел</h1>
  <p class="subtitle">Сохранённые дела из локальной базы проекта.</p>
  <button class="secondary" onclick="loadCases()">Обновить список</button>
  <div id="casesList" style="margin-top:15px">Загрузка...</div>
</section>

<section id="laws" class="tab">
  <h1>Все законы</h1>
  <p class="subtitle">Загруженные нормативные документы RPM.</p>

  <div class="panel">
    <input id="lawSearch" placeholder="Поиск по названию или тексту..." oninput="renderLaws()">
    <div id="lawsList" style="margin-top:15px">Загрузка законов...</div>
  </div>

  <div class="panel">
    <h2>Редактор базы законов</h2>
    <p class="muted">Здесь можно изменить полный JSON базы законов. Перед сохранением автоматически проверяется формат JSON.</p>
    <textarea id="lawsEditor" style="min-height:260px" placeholder="Загрузка базы законов..."></textarea>
    <button class="primary" onclick="saveLaws()">Сохранить изменения в laws.json</button>
    <button class="secondary" onclick="loadLaws()">Отменить изменения и загрузить оригинал</button>
  </div>
</section>

</main>

<div id="toast"></div>

<script>
let lawsData = { documents: [] };
let casesData = [];
let lastAnalysis = "";

const $ = id => document.getElementById(id);

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.style.display = "block";
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => el.style.display = "none", 3000);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || data.message || `Ошибка сервера: ${response.status}`);
  }

  return data;
}

function showResult(id, text) {
  const el = $(id);
  el.textContent = text || "Сервер вернул пустой ответ.";
  el.classList.remove("hidden");
}

function getCaseData() {
  return {
    title: $("caseTitle").value.trim(),
    description: $("caseDescription").value.trim(),
    evidence: $("caseEvidence").value.trim()
  };
}

function getCurrentContext() {
  const data = getCaseData();
  return {
    ...data,
    additionalContext: $("questionsContext").value.trim()
  };
}

async function checkHealth() {
  try {
    const data = await api("/api/health");
    const status = $("systemStatus");

    if (data.aiConfigured) {
      status.innerHTML = '<strong>ИИ подключён</strong> · Сервер работает';
    } else {
      status.innerHTML = '<span style="color:#edb66a">ИИ не настроен</span> · Сервер работает';
    }
  } catch (error) {
    $("systemStatus").textContent = "Сервер недоступен";
  }
}

async function loadLaws() {
  try {
    lawsData = await api("/api/laws");
    $("lawsEditor").value = JSON.stringify(lawsData, null, 2);
    renderLaws();
  } catch (error) {
    $("lawsList").textContent = "Не удалось загрузить законы: " + error.message;
  }
}

function getDocuments() {
  if (Array.isArray(lawsData)) return lawsData;
  if (lawsData && Array.isArray(lawsData.documents)) return lawsData.documents;
  return [];
}

function renderLaws() {
  const list = $("lawsList");
  const query = $("lawSearch").value.toLowerCase().trim();
  const docs = getDocuments();

  const filtered = docs.filter(doc =>
    JSON.stringify(doc).toLowerCase().includes(query)
  );

  if (!filtered.length) {
    list.textContent = "Документы не найдены.";
    return;
  }

  list.innerHTML = "";

  filtered.forEach(doc => {
    const item = document.createElement("div");
    item.className = "law-item";

    const title = document.createElement("h3");
    title.textContent = doc.name || doc.title || doc.id || "Документ";

    const category = document.createElement("div");
    category.className = "muted";
    category.textContent = doc.category || "Без категории";

    const details = document.createElement("pre");
    details.textContent = JSON.stringify(doc, null, 2);

    const button = document.createElement("button");
    button.className = "secondary";
    button.textContent = "Показать / скрыть содержимое";
    button.onclick = () => {
      details.classList.toggle("hidden");
    };

    details.classList.add("hidden");
    item.append(title, category, button, details);
    list.appendChild(item);
  });
}

async function saveLaws() {
  try {
    const parsed = JSON.parse($("lawsEditor").value);
    await api("/api/laws", {
      method: "PUT",
      body: JSON.stringify(parsed)
    });
    lawsData = parsed;
    renderLaws();
    toast("База законов сохранена.");
  } catch (error) {
    toast("Не удалось сохранить: " + error.message);
  }
}

async function runAI(mode) {
  const targets = {
    analyze: "analysisResult",
    evaluate_answer: "evaluationResult",
    followup: "followupResult",
    questions: "questionsResult",
    reference: "referenceResult"
  };

  const target = targets[mode];
  if (!target) return;

  let caseData = getCurrentContext();

  if (mode === "questions") {
    caseData.description = $("questionsContext").value.trim();
  }

  if (mode === "reference") {
    caseData.description = $("referenceQuestion").value.trim();
  }

  if (mode === "evaluate_answer" || mode === "followup") {
    caseData.description = $("caseDescription").value.trim();
  }

  if (mode === "reference" && !caseData.description) {
    toast("Сначала напишите вопрос.");
    return;
  }

  if (mode === "questions" && !caseData.description) {
    toast("Сначала опишите ситуацию.");
    return;
  }

  if (mode === "evaluate_answer" && !$("officerAnswer").value.trim()) {
    toast("Сначала вставьте ответ сотрудника.");
    return;
  }

  const result = $(target);
  result.classList.remove("hidden");
  result.textContent = "ИИ анализирует материалы...";

  const buttons = document.querySelectorAll("button.primary");
  buttons.forEach(button => button.disabled = true);

  try {
    const data = await api("/api/attorney-assist", {
      method: "POST",
      body: JSON.stringify({
        mode,
        caseData,
        laws: lawsData,
        officerAnswer: $("officerAnswer").value.trim()
      })
    });

    const answer = data.answer || data.message || "Ответ не получен.";
    showResult(target, answer);

    if (mode === "analyze") lastAnalysis = answer;
  } catch (error) {
    showResult(target, "Ошибка: " + error.message);
  } finally {
    buttons.forEach(button => button.disabled = false);
  }
}

async function saveCurrentCase() {
  const data = getCaseData();

  if (!data.description) {
    toast("Сначала заполните описание дела.");
    return;
  }

  try {
    await api("/api/cases", {
      method: "POST",
      body: JSON.stringify({
        title: data.title || "Новое дело",
        data: {
          ...data,
          analysis: lastAnalysis,
          evidence: data.evidence
        }
      })
    });

    toast("Дело сохранено.");
    loadCases();
  } catch (error) {
    toast("Ошибка сохранения: " + error.message);
  }
}

async function loadCases() {
  const list = $("casesList");
  list.textContent = "Загрузка дел...";

  try {
    const data = await api("/api/cases");
    casesData = Array.isArray(data) ? data : (data.cases || []);

    if (!casesData.length) {
      list.textContent = "Сохранённых дел пока нет.";
      return;
    }

    list.innerHTML = "";

    casesData.forEach(item => {
      const card = document.createElement("div");
      card.className = "case-item";

      const title = document.createElement("h3");
      title.textContent = item.title || "Без названия";

      const date = document.createElement("div");
      date.className = "muted";
      date.textContent = item.createdAt || item.date || "";

      const open = document.createElement("button");
      open.className = "secondary";
      open.textContent = "Открыть";
      open.onclick = () => openCase(item);

      const remove = document.createElement("button");
      remove.className = "danger";
      remove.textContent = "Удалить";
      remove.onclick = () => deleteCase(item.id);

      card.append(title, date, open, remove);
      list.appendChild(card);
    });
  } catch (error) {
    list.textContent = "Ошибка загрузки: " + error.message;
  }
}

function openCase(item) {
  const data = item.data || {};

  $("caseTitle").value = item.title || data.title || "";
  $("caseDescription").value = data.description || data.caseText || "";
  $("caseEvidence").value = data.evidence || "";
  lastAnalysis = data.analysis || "";

  if (lastAnalysis) showResult("analysisResult", lastAnalysis);

  document.querySelector('[data-tab="analysis"]').click();
  toast("Дело загружено.");
}

async function deleteCase(id) {
  if (!id) {
    toast("У дела отсутствует ID.");
    return;
  }

  if (!confirm("Удалить это дело?")) return;

  try {
    await api("/api/cases/" + encodeURIComponent(id), {
      method: "DELETE"
    });
    toast("Дело удалено.");
    loadCases();
  } catch (error) {
    toast("Ошибка удаления: " + error.message);
  }
}

document.querySelectorAll("nav button").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach(item => item.classList.remove("active"));
    document.querySelectorAll(".tab").forEach(item => item.classList.remove("active"));

    button.classList.add("active");
    $(button.dataset.tab).classList.add("active");
  });
});

async function init() {
  await Promise.allSettled([
    checkHealth(),
    loadLaws(),
    loadCases()
  ]);
}

init();
</script>

</body>
</html>
'''

INDEX.write_text(html, encoding="utf-8")

print()
print("Готово! Новый index.html создан.")
print(f"Файл: {INDEX}")
print()
print("Теперь обнови страницу в браузере сочетанием Ctrl + F5.")