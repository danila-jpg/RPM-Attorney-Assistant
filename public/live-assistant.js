const $ = id => document.getElementById("live" + id);
const dialog = $("Dialog");
const draft = $("Text");
const speech = $("Speech");
const status = $("Status");
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const settings = $("Settings");
const media = navigator.mediaDevices;
const blocked = "Микрофон заблокирован. Откройте разрешения сайта у адресной строки, разрешите микрофон и повторите проверку. Проверьте также доступ браузера к микрофону в настройках ОС.";
const captureIssue = !isSecureContext ? "Для микрофона откройте сайт по HTTPS."
  : !media?.getUserMedia ? "Запись с микрофона недоступна в этом браузере." : "";
let capture;
let pending = false;
let granted = false;

async function readPermission() {
  return navigator.permissions?.query({ name: "microphone" }).catch(() => undefined);
}

async function diagnose() {
  const permissionState = await readPermission();
  if (!settings.open) return;
  const state = permissionState?.state;
  $("Permission").textContent = { granted: "Разрешено", denied: "Заблокировано", prompt: "Ожидает разрешения" }[state]
    || (granted ? "Доступ подтверждён" : "Браузер не раскрывает статус");
  $("Secure").textContent = captureIssue || (location.protocol === "https:" ? "HTTPS" : "Защищённый локальный контекст");
  $("Recognition").textContent = Recognition ? "API доступен. Сервис проверяется при диктовке." : "API отсутствует";
  const devices = granted || state === "granted"
    ? await media?.enumerateDevices?.().catch(() => undefined) : undefined;
  const inputs = devices?.filter(device => device.kind === "audioinput");
  $("Devices").replaceChildren(...(inputs?.length
    ? inputs.map((device, i) => element("li", device.label || `Микрофон ${i + 1}`))
    : [element("li", inputs ? "Микрофоны не найдены" : "Список доступен после разрешения")]));
}

function releaseCapture() {
  const current = capture;
  capture = null;
  if (current) {
    cancelAnimationFrame(current.frame);
    current.stream.getTracks().forEach(track => track.stop());
    void current.context?.close().catch(() => {});
  }
  $("Level").value = 0;
  const wave = $("Wave");
  wave.getContext("2d")?.clearRect(0, 0, wave.width, wave.height);
}

function showSignal(current) {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return false;
  try {
    const context = current.context = new Audio();
    void context.resume().catch(() => {});
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(current.stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const wave = $("Wave");
    const pen = wave.getContext("2d");
    const render = () => {
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample ** 2, 0) / samples.length);
      $("Level").value = Math.min(1, rms * 4);
      if (pen) {
        pen.clearRect(0, 0, wave.width, wave.height);
        pen.beginPath();
        for (let i = 0; i < samples.length; i++) {
          pen.lineTo(i * wave.width / (samples.length - 1), wave.height * (1 - samples[i]) / 2);
        }
        pen.strokeStyle = "#c4a4ff";
        pen.lineWidth = 2;
        pen.stroke();
      }
      current.frame = requestAnimationFrame(render);
    };
    render();
    return true;
  } catch {
    return false;
  }
}

async function acquire() {
  if (captureIssue) throw new Error(captureIssue);
  const before = await readPermission();
  if (before?.state === "denied") throw new Error(blocked);
  try {
    const stream = await media.getUserMedia({ audio: true });
    granted = true;
    if (stream.getAudioTracks().some(track => track.readyState === "live")) return stream;
    stream.getTracks().forEach(track => track.stop());
    throw new DOMException("", "NotFoundError");
  } catch (error) {
    if (error.name === "NotAllowedError") {
      throw new Error((await readPermission())?.state === "denied" && before?.state !== "prompt"
        ? blocked : "Доступ к микрофону отклонён. Разрешите микрофон для сайта у адресной строки и повторите проверку.");
    }
    const messages = {
      NotFoundError: "Микрофон не найден. Подключите устройство ввода.",
      NotReadableError: "Микрофон занят или недоступен системе. Закройте другие приложения и проверьте настройки ОС.",
      AbortError: "Браузер прервал подключение микрофона. Повторите проверку.",
      SecurityError: blocked
    };
    throw new Error(messages[error.name] || "Не удалось подключить микрофон.");
  }
}
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
  $("Mic").disabled = !Recognition || !!captureIssue || pending || !!capture || !!recording || locked;
  $("Mic").hidden = !!recording;
  $("Stop").hidden = !recording;
  $("Stop").disabled = !!recording?.stopping;
  if (recording && document.activeElement === document.body && dialog.open && !settings.open) $("Stop").focus();
  $("Language").disabled = !!recording;
  $("Test").disabled = $("Recheck").disabled = pending || !!recording;
  $("Test").textContent = capture?.test ? "Остановить проверку" : "Проверить микрофон";
  $("Cancel").hidden = !activeRequest;
  $("Activity").textContent = recording ? "Диктовка" : locked ? "В работе" : "Готов";
  for (const control of $("History").querySelectorAll("button")) control.disabled = locked || !!recording;
  for (const control of $("Templates").querySelectorAll("button")) control.disabled = draft.readOnly;
}

const speechErrors = {
  "not-allowed": ["permission", "Браузер отклонил доступ сервиса распознавания. " + blocked],
  "service-not-allowed": ["other", "Сервис распознавания недоступен. Проверьте диктовку в Chrome или введите текст вручную."],
  "audio-capture": ["microphone", "Микрофон недоступен. Проверьте подключение."],
  "no-speech": ["no-speech", "Речь не обнаружена. Проверьте входной сигнал и микрофон по умолчанию в диагностике."],
  aborted: ["aborted", "Распознавание прервано."],
  network: ["network", "Сетевая ошибка сервиса распознавания. Проверьте соединение. Если ошибка повторяется в Opera GX или Edge, проверьте диктовку в Chrome."],
  "language-not-supported": ["other", "Выбранный язык недоступен в этом браузере."]
};

function speechError(code) {
  const [group, message] = speechErrors[code] || ["other", "Ошибка сервиса распознавания. Попробуйте снова или введите текст вручную."];
  speech.textContent = "Ошибка. " + message;
  $("Diagnostics").hidden = false;
  metric("speech_error", group);
}

function stopSpeech(discard = false) {
  if (!recording) return;
  const current = recording;
  if (discard || !current.api) {
    recording = null;
    clearTimeout(current.timer);
    releaseCapture();
    dialog.classList.remove("live-listening");
    draft.value = current.final || current.base;
    speech.textContent = "Микрофон выключен";
    try { current.api?.abort(); } catch { /* Recognition may already have ended. */ }
  } else {
    current.stopping = true;
    speech.textContent = "Распознавание…";
    dialog.classList.remove("live-listening");
    try { current.api.stop(); }
    catch {
      recording = null;
      releaseCapture();
      draft.value = current.final || current.base;
      speechError("aborted");
    }
    if (recording === current) {
      clearTimeout(current.timer);
      current.timer = setTimeout(() => { stopSpeech(true); speechError("other"); }, 3000);
    }
  }
  syncControls();
}

async function startSpeech() {
  if ($("Mic").disabled) return;
  const current = { base: draft.value, final: "", error: false, stopping: false };
  recording = current;
  pending = true;
  $("Diagnostics").hidden = true;
  speech.textContent = "Запрос разрешения…";
  syncControls();
  try {
    const stream = await acquire();
    if (recording !== current) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    capture = { stream };
    showSignal(capture);
    stream.getAudioTracks().forEach(track => track.addEventListener("ended", () => {
      if (recording !== current || current.stopping) return;
      stopSpeech(true);
      speechError("audio-capture");
    }));
    const api = current.api = new Recognition();
    api.lang = $("Language").value;
    api.interimResults = true;
    api.continuous = true;
    speech.textContent = "Подключение сервиса распознавания…";
    current.timer = setTimeout(() => { stopSpeech(true); speechError("other"); }, 10000);
    api.onstart = () => {
      if (recording !== current || current.stopping) return;
      clearTimeout(current.timer);
      current.started = true;
      dialog.classList.add("live-listening");
      speech.textContent = "Прослушивание…";
    };
    api.onaudiostart = api.onsoundstart = () => {
      if (recording === current && !current.stopping) dialog.classList.add("live-listening");
    };
    api.onspeechstart = () => {
      if (recording === current && !current.stopping) speech.textContent = "Распознавание…";
    };
    api.onspeechend = api.onsoundend = () => {
      if (recording === current && !current.stopping) speech.textContent = "Прослушивание…";
    };
    api.onaudioend = () => {
      if (recording !== current) return;
      releaseCapture();
      dialog.classList.remove("live-listening");
    };
    api.onnomatch = () => {
      if (recording !== current || current.stopping) return;
      current.noMatch = true;
      speech.textContent = "Речь слышна, но слова не распознаны.";
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
      releaseCapture();
      dialog.classList.remove("live-listening");
      speechError(error);
      clearTimeout(current.timer);
      current.timer = setTimeout(() => {
        if (recording !== current) return;
        const message = speech.textContent;
        stopSpeech(true);
        speech.textContent = message;
      }, 1000);
    };
    api.onend = () => {
      if (recording !== current) return;
      recording = null;
      clearTimeout(current.timer);
      releaseCapture();
      dialog.classList.remove("live-listening");
      draft.value = current.final || current.base;
      if (!current.error) {
        if (draft.value === current.base && !current.stopping && !current.noMatch) speechError(current.started ? "no-speech" : "other");
        else if (current.noMatch && draft.value === current.base && !current.stopping) $("Diagnostics").hidden = false;
        else if (draft.value === current.base) speech.textContent = "Микрофон выключен";
        else speech.textContent = "Готово. Текст можно исправить.";
      }
      syncControls();
    };
    // Browsers with the audioTrack overload can meter and transcribe the same stream.
    // Older Web Speech implementations ignore the argument and use their default input.
    api.start(stream.getAudioTracks()[0]);
  } catch (error) {
    if (recording === current) {
      stopSpeech(true);
      if (current.api) speechError(error.name === "NotAllowedError" ? "not-allowed" : "other");
      else {
        speech.textContent = error.message;
        $("Diagnostics").hidden = false;
        metric("speech_error", "microphone");
      }
    }
  } finally {
    pending = false;
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
  const fields = answerFields(result);
  for (const index of [1, 2, 3, 4, 0]) {
    const [label, value] = fields[index];
    list.append(element("dt", label), element("dd", value));
  }
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
    const timing = `Ответ получен за ${Math.round(performance.now() - started)} мс.`;
    status.textContent = result.fallback
      ? `Gemini недоступен. Показана стандартная RP-фраза без правовой оценки. ${timing}`
      : timing;
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
  if ($("Compact").checked) dialog.show();
  else dialog.showModal();
  metric("opened");
  if (!Recognition || captureIssue) {
    speech.textContent = captureIssue || "В этом браузере диктовка недоступна. Микрофон можно проверить в настройках.";
    $("Diagnostics").hidden = false;
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
dialog.addEventListener("close", () => {
  if (dialog.open) return;
  stopSpeech(true);
  settings.close();
  activeRequest?.abort();
});
function openSettings() {
  stopSpeech(true);
  settings.showModal();
  void diagnose();
}
$("SettingsOpen").addEventListener("click", openSettings);
$("Diagnostics").addEventListener("click", openSettings);
$("SettingsClose").addEventListener("click", () => settings.close());
settings.addEventListener("close", () => {
  releaseCapture();
  $("TestStatus").textContent = "";
  syncControls();
});
async function testMicrophone() {
  if (pending || recording) return;
  releaseCapture();
  pending = true;
  syncControls();
  $("TestStatus").textContent = "Подключение микрофона…";
  try {
    const stream = await acquire();
    if (!settings.open) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    capture = { stream, test: true };
    $("TestStatus").textContent = showSignal(capture)
      ? "Скажите несколько слов и проверьте уровень сигнала." : "Микрофон подключён. Индикатор звука недоступен.";
    stream.getAudioTracks().forEach(track => track.addEventListener("ended", () => {
      if (capture?.stream !== stream) return;
      releaseCapture();
      $("TestStatus").textContent = "Микрофон отключился.";
      syncControls();
    }));
  } catch (error) {
    if (settings.open) $("TestStatus").textContent = error.message;
  } finally {
    pending = false;
    syncControls();
    void diagnose();
  }
}
$("Test").addEventListener("click", () => {
  if (capture?.test) {
    releaseCapture();
    $("TestStatus").textContent = "Проверка остановлена.";
    syncControls();
  } else void testMicrophone();
});
$("Recheck").addEventListener("click", testMicrophone);
media?.addEventListener("devicechange", diagnose);
window.addEventListener("pagehide", () => { stopSpeech(true); releaseCapture(); });
$("Mic").addEventListener("click", startSpeech);
$("Stop").addEventListener("click", () => stopSpeech());
$("Clear").addEventListener("click", clearDraft);
$("Add").addEventListener("click", saveDraft);
$("Analyze").addEventListener("click", analyze);
$("Cancel").addEventListener("click", () => { activeRequest?.abort(); syncControls(); });
$("Copy").addEventListener("click", () => copy($("Compact").checked ? session.result.phrase : answerText(session.result)));
$("Save").addEventListener("click", saveCase);
const handle = $("Title");
function moveCompact(x, y) {
  const left = Math.max(0, Math.min(x, innerWidth - dialog.offsetWidth));
  const top = Math.max(0, Math.min(y, innerHeight - dialog.offsetHeight));
  dialog.style.setProperty("--live-x", left + "px");
  dialog.style.setProperty("--live-y", top + "px");
}
$("Compact").addEventListener("change", event => {
  dialog.classList.toggle("live-compact", event.target.checked);
  handle.tabIndex = event.target.checked ? 0 : -1;
  dialog.close();
  if (event.target.checked) {
    dialog.show();
    moveCompact(innerWidth - dialog.offsetWidth - 16, 16);
  } else dialog.showModal();
  $("Compact").focus();
});
dialog.addEventListener("keydown", event => {
  if (event.key === "Escape" && $("Compact").checked) dialog.close();
});
let drag;
handle.addEventListener("pointerdown", event => {
  if (!$("Compact").checked || event.button !== 0) return;
  const { left, top } = dialog.getBoundingClientRect();
  drag = { id: event.pointerId, x: event.clientX - left, y: event.clientY - top };
  handle.setPointerCapture(event.pointerId);
});
handle.addEventListener("pointermove", event => {
  if (drag?.id === event.pointerId) moveCompact(event.clientX - drag.x, event.clientY - drag.y);
});
handle.addEventListener("lostpointercapture", () => { drag = null; });
handle.addEventListener("keydown", event => {
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (!$("Compact").checked || !direction) return;
  event.preventDefault();
  const { left, top } = dialog.getBoundingClientRect();
  moveCompact(left + direction[0] * 16, top + direction[1] * 16);
});
new ResizeObserver(() => {
  if (!dialog.open || !$("Compact").checked) return;
  const { left, top } = dialog.getBoundingClientRect();
  moveCompact(left, top);
}).observe(dialog);
window.addEventListener("resize", () => {
  if (dialog.open && $("Compact").checked) {
    const { left, top } = dialog.getBoundingClientRect();
    moveCompact(left, top);
  }
});
$("Reset").addEventListener("click", () => {
  if ((draft.value.trim() || session.entries.length) && !confirm("Завершить текущую сессию и начать новую?")) return;
  stopSpeech(true);
  activeRequest?.abort();
  session = newSession();
  clearDraft();
  renderHistory();
  const empty = element("p", "Опишите ситуацию и запросите подсказку.");
  empty.className = "live-note";
  $("Answer").replaceChildren(empty);
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
