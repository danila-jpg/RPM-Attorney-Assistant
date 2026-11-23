const $ = id => document.getElementById("live" + id);
const dialog = $("Dialog");
const draft = $("Text");
const speech = $("Speech");
const status = $("Status");
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const templates = {
  "Задержание": "Кого, когда и на каком основании задержали?",
  "Обыск": "Кого или что обыскали? Какое основание назвал сотрудник?",
  "Арест": "Кого арестовали? Какое обвинение предъявлено?",
  "Допрос": "Кого допрашивают, в каком статусе и какие вопросы заданы?",
  "Требование документов": "Какие документы запросили, кто и на каком основании?",
  "Нарушение прав": "Какие действия совершены и чем они подтверждаются?",
  "Судебная ситуация": "Какой вопрос рассматривается и на какой стадии находится дело?",
  "Другое": "Что произошло, кто участвовал и что нужно уточнить?"
};
const phrases = [
  "Назовите, пожалуйста, основание задержания.",
  "Уточните, пожалуйста, правовое основание обыска.",
  "Прошу разъяснить права моего доверителя в этой ситуации.",
  "Уточните, пожалуйста, какое обвинение предъявлено.",
  "Какие доказательства подтверждают ваше утверждение?",
  "Заявляю возражение. Прошу уточнить основание этого действия.",
  "Прошу зафиксировать эти обстоятельства."
];

function newSession() {
  return { id: crypto.randomUUID(), entries: [], result: null, analyzedEntries: null, answers: [] };
}

let session;
let editing = -1;
let recording;
let activeRequest;
let saving = false;
let favoritePhrases = new Map();

const element = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });

function button(text, action) {
  const control = element("button", text);
  control.type = "button";
  control.className = "secondary";
  control.addEventListener("click", action);
  return control;
}

async function post(url, body, signal) {
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal
  });
  if (response.status === 204) return;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Запрос не выполнен. Проверьте доступ и соединение.");
  return data;
}

function metric(event, code) {
  void post("/api/live/event", { event, code }).catch(() => {});
}

async function copy(value) {
  try {
    await navigator.clipboard.writeText(value);
    status.textContent = "Скопировано.";
  } catch {
    status.textContent = "Копирование недоступно. Выделите текст и скопируйте вручную.";
  }
}

function syncControls() {
  const locked = !!activeRequest || saving;
  draft.readOnly = !!recording || locked;
  $("Kind").disabled = $("Mode").disabled = $("Clear").disabled = locked || !!recording;
  $("Analyze").disabled = $("Add").disabled = locked || !!recording;
  $("Cancel").disabled = !activeRequest || activeRequest.signal.aborted;
  $("Save").disabled = locked || !!recording || !session?.entries.length;
  $("Reset").disabled = saving;
  $("Mic").disabled = !Recognition || !isSecureContext || !!recording || locked;
  $("Stop").disabled = !recording || recording.stopping;
  $("Language").disabled = !!recording;
  for (const control of $("History").querySelectorAll("button")) control.disabled = locked || !!recording;
  for (const control of $("Templates").querySelectorAll("button")) control.disabled = draft.readOnly;
}

const speechErrors = {
  "not-allowed": ["permission", "Доступ к микрофону отклонён. Проверьте разрешения браузера."],
  "service-not-allowed": ["permission", "Браузер запретил сервис распознавания."],
  "audio-capture": ["microphone", "Микрофон недоступен. Проверьте подключение."],
  "no-speech": ["no-speech", "Речь не обнаружена. Попробуйте снова."],
  aborted: ["aborted", "Распознавание прервано."],
  network: ["network", "Сетевая ошибка распознавания."],
  "language-not-supported": ["other", "Выбранный язык недоступен в этом браузере."]
};

function speechError(code) {
  const [group, message] = speechErrors[code] || ["other", "Не удалось распознать речь."];
  speech.textContent = "Ошибка. " + message;
  metric("speech_error", group);
}

function stopSpeech(discard = false) {
  if (!recording) return;
  const current = recording;
  if (discard) {
    recording = null;
    draft.value = current.final || current.base;
    speech.textContent = "Микрофон выключен";
    try { current.api.abort(); } catch { /* Recognition may already have ended. */ }
  } else {
    current.stopping = true;
    speech.textContent = "Распознавание…";
    try { current.api.stop(); }
    catch {
      recording = null;
      draft.value = current.final || current.base;
      speechError("aborted");
    }
  }
  syncControls();
}

function startSpeech() {
  if ($("Mic").disabled) return;
  try {
    const api = new Recognition();
    const current = { api, base: draft.value, final: "", error: false, stopping: false };
    recording = current;
    api.lang = $("Language").value;
    api.interimResults = true;
    api.continuous = true;
    speech.textContent = "Запрос разрешения…";
    api.onstart = () => {
      if (recording === current && !current.stopping) speech.textContent = "Прослушивание…";
    };
    api.onspeechstart = () => {
      if (recording === current && !current.stopping) speech.textContent = "Распознавание…";
    };
    api.onresult = ({ results }) => {
      if (recording !== current || current.error) return;
      const segments = Array.from(results);
      const join = items => [current.base, ...items.map(item => item[0].transcript.trim())]
        .filter(Boolean).join(" ").slice(0, draft.maxLength);
      current.final = join(segments.filter(item => item.isFinal));
      draft.value = join(segments);
    };
    api.onerror = ({ error }) => {
      if (recording !== current) return;
      current.error = true;
      speechError(error);
    };
    api.onend = () => {
      if (recording !== current) return;
      recording = null;
      draft.value = current.final || current.base;
      if (!current.error) {
        if (draft.value === current.base) speechError("no-speech");
        else speech.textContent = "Готово. Текст можно исправить.";
      }
      syncControls();
    };
    syncControls();
    api.start();
  } catch (error) {
    recording = null;
    speechError(error.name === "NotAllowedError" ? "not-allowed" : "other");
    syncControls();
  }
}

function clearDraft() {
  editing = -1;
  draft.value = "";
  $("Add").textContent = "Добавить запись";
}

function renderHistory() {
  const rows = session.entries.map(({ kind, text }, index) => {
    const row = element("li", kind + " · " + text + " ");
    row.append(button("Исправить", () => {
      if (draft.value.trim() && !confirm("Заменить текст в редакторе?")) return;
      editing = index;
      draft.value = text;
      $("Kind").value = kind;
      $("Add").textContent = "Сохранить исправление";
      draft.focus();
    }));
    return row;
  });
  for (const { entryCount, phrase } of session.answers) {
    rows.push(element("li", "Подсказка после записи " + entryCount + " · " + phrase));
  }
  $("History").replaceChildren(...rows);
}

function saveDraft() {
  const text = draft.value.trim();
  if (!text) return true;
  if (editing < 0 && session.entries.length >= 20) {
    status.textContent = "В сессии уже 20 записей. Сохраните её в дело и начните новую.";
    return false;
  }
  const entry = { kind: $("Kind").value, text };
  if (editing < 0) session.entries.push(entry);
  else session.entries[editing] = entry;
  clearDraft();
  renderHistory();
  syncControls();
  return true;
}

function answerFields(result) {
  return [
    ["Что происходит", result.summary || "Требуется уточнение."],
    ["Что можно сказать", result.phrase],
    ["Правовое основание", result.grounds.map(item => item.reference).join("\n") || "Проверенная норма RPM не найдена."],
    ["Что делать дальше", result.next],
    ["Уверенность", { high: "Высокая", medium: "Средняя", low: "Низкая" }[result.confidence]]
  ];
}

function answerText(result) {
  return [...answerFields(result), ...(result.details || []).map(({ label, items }) => [label, items.join("\n")])]
    .filter(([, value]) => value).map(([label, value]) => label + "\n" + value).join("\n\n");
}

function renderAnswer(result) {
  const list = element("dl", "");
  for (const [label, value] of answerFields(result)) list.append(element("dt", label), element("dd", value));
  const nodes = [list];
  for (const { reference, text } of result.grounds) {
    const source = element("details", "");
    source.append(element("summary", reference), element("p", text));
    nodes.push(source);
  }
  for (const { label, items } of result.details || []) {
    if (items.length) {
      const block = element("details", "");
      block.append(element("summary", label), ...items.map(item => element("p", item)));
      nodes.push(block);
    }
  }
  $("Answer").replaceChildren(...nodes);
  $("Copy").disabled = false;
}

async function analyze() {
  if ($("Analyze").disabled || !saveDraft()) return;
  if (!session.entries.length) {
    status.textContent = "Добавьте описание ситуации.";
    return draft.focus();
  }
  const request = new AbortController();
  const current = session;
  const detail = $("Mode").value;
  const started = performance.now();
  activeRequest = request;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; request.abort(); }, detail === "full" ? 40_000 : 20_000);
  syncControls();
  status.textContent = "Анализ и проверка источников…";
  try {
    const entries = [...current.entries];
    const result = await post("/api/live/analyze", {
      mode: "live_quick_analysis", detail, entries
    }, request.signal);
    if (current !== session || request.signal.aborted) return;
    current.result = result;
    current.analyzedEntries = entries;
    current.answers.push({ entryCount: entries.length, phrase: result.phrase, detail });
    if (current.answers.length > 20) current.answers.shift();
    renderAnswer(result);
    renderHistory();
    status.textContent = result.fallback
      ? "Gemini недоступен. Показана стандартная RP-фраза без правовой оценки."
      : `Ответ получен за ${Math.round(performance.now() - started)} мс. Сервер: ${result.elapsedMs} мс.`;
  } catch (error) {
    if (current === session) status.textContent = timedOut ? "Время ожидания истекло."
      : request.signal.aborted ? "Запрос отменён." : error.message;
  } finally {
    clearTimeout(timer);
    if (activeRequest === request) activeRequest = null;
    syncControls();
  }
}

async function saveCase() {
  if ($("Save").disabled || !saveDraft()) return;
  saving = true;
  syncControls();
  try {
    const description = session.entries.map(({ kind, text }) => kind + " · " + text).join("\n");
    await post("/api/cases", {
      id: session.id,
      title: "Live · " + session.entries[0].text.slice(0, 180),
      data: { description, analysis: session.result ? answerText(session.result) : "", liveSession: session }
    }, AbortSignal.timeout(20_000));
    status.textContent = "Ситуация сохранена в истории дел.";
    if (typeof window.loadCases === "function") void window.loadCases();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    saving = false;
    syncControls();
  }
}

function openLive() {
  if (dialog.open || document.querySelector("dialog[open]")) return;
  session ??= newSession();
  dialog.showModal();
  metric("opened");
  if (!Recognition || !isSecureContext) {
    speech.textContent = "В этом браузере или соединении диктовка недоступна. Введите текст вручную.";
    metric("speech_error", "unsupported");
  }
  syncControls();
}

for (const [label, template] of Object.entries(templates)) {
  $("Templates").append(button(label, () => {
    draft.setRangeText(template, draft.selectionStart, draft.selectionEnd, "select");
    draft.value = draft.value.slice(0, draft.maxLength);
    draft.focus();
  }));
}

function renderPhrases() {
  $("Phrases").replaceChildren(...phrases.map((phrase, index) => {
    const row = element("div", "");
    const input = element("textarea", "");
    input.value = favoritePhrases.get(index) ?? phrase;
    input.setAttribute("aria-label", "RP-фраза " + (index + 1));
    input.rows = 2;
    input.maxLength = 500;
    const favorite = button("В избранное", async () => {
      if (!input.value.trim()) return;
      favorite.disabled = true;
      try {
        await post("/api/live/phrases", { slot: index, text: input.value.trim() });
        favoritePhrases.set(index, input.value.trim());
        status.textContent = "Фраза сохранена в избранном.";
      } catch (error) { status.textContent = error.message; }
      finally { favorite.disabled = false; }
    });
    row.append(input, button("Копировать", () => copy(input.value)), favorite);
    return row;
  }));
}

renderPhrases();
fetch("/api/live/phrases").then(response => response.ok ? response.json() : null).then(data => {
  if (!data) return;
  favoritePhrases = new Map(data.phrases.map(({ slot, text }) => [slot, text]));
    if (!dialog.open || !$("Phrases").closest("details").open) renderPhrases();
}).catch(() => {});

$("Open").addEventListener("click", openLive);
if (location.hash === "#live") openLive();
window.addEventListener("hashchange", () => { if (location.hash === "#live") openLive(); });
$("Close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => { stopSpeech(true); activeRequest?.abort(); });
$("Mic").addEventListener("click", startSpeech);
$("Stop").addEventListener("click", () => stopSpeech());
$("Clear").addEventListener("click", clearDraft);
$("Add").addEventListener("click", saveDraft);
$("Analyze").addEventListener("click", analyze);
$("Cancel").addEventListener("click", () => { activeRequest?.abort(); syncControls(); });
$("Copy").addEventListener("click", () => copy(answerText(session.result)));
$("Save").addEventListener("click", saveCase);
$("Compact").addEventListener("change", event => dialog.classList.toggle("live-compact", event.target.checked));
$("Reset").addEventListener("click", () => {
  if ((draft.value.trim() || session.entries.length) && !confirm("Завершить текущую сессию и начать новую?")) return;
  stopSpeech(true);
  activeRequest?.abort();
  session = newSession();
  clearDraft();
  renderHistory();
  $("Answer").replaceChildren();
  $("Copy").disabled = true;
  status.textContent = "Начата новая ситуация.";
  syncControls();
});
document.addEventListener("keydown", event => {
  if (event.defaultPrevented || event.repeat || event.isComposing || !event.ctrlKey || event.altKey || event.metaKey) return;
  if (dialog.open && !event.shiftKey && event.key === "Enter" && dialog.contains(event.target)) {
    event.preventDefault();
    void analyze();
  } else if (event.shiftKey && event.code === "KeyL" &&
      !event.target.closest("input, textarea, select, [contenteditable]")) {
    event.preventDefault();
    openLive();
  }
});
