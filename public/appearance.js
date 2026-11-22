import { defaultTheme, defaultPreferences, themes, isTheme, customPalette, normalizeCustomTheme,
  themeDraft, themeControls, themeColorLabels, importTheme, exportTheme } from "./theme-catalog.js";

const root = document.documentElement;
const dark = matchMedia("(prefers-color-scheme: dark)");
const tokens = ["bg", "surface", "surface-hover", "text", "text-muted", "accent", "accent-hover", "border", "input-bg", "accent-text"];
let appearance = { theme: defaultTheme, preferences: defaultPreferences };
const updates = new BroadcastChannel("rpm-appearance-updates");
let refreshMounted;

function setPalette(node, palette) {
  tokens.forEach((token, index) => node.style.setProperty("--" + token, palette.colors[index]));
  node.style.setProperty("--button-bg", palette.button || palette.colors[5]);
  node.style.setProperty("--button-text", palette.buttonText || palette.colors[9]);
  node.style.setProperty("--theme-sidebar", palette.sidebar || "color-mix(in srgb, var(--surface) 72%, var(--bg))");
  node.style.setProperty("--theme-link", palette.link || palette.colors[5]);
  node.style.setProperty("--theme-selection", palette.selection || palette.colors[2]);
  node.style.setProperty("--card-radius", palette.cardRadius == null ? "" : palette.cardRadius + "px");
  node.style.setProperty("--button-radius", palette.buttonRadius == null ? "" : palette.buttonRadius + "px");
  node.style.setProperty("--button-hover", palette.button ? palette.button : palette.colors[6]);
  node.style.colorScheme = palette.light ? "light" : "dark";
}

export function applyAppearance(profile = {}) {
  const custom = profile.preferences?.customThemes?.map(customPalette).find(item => item?.id === profile.theme);
  const theme = isTheme(profile.theme) || custom ? profile.theme : defaultTheme;
  const preferences = { ...defaultPreferences, ...profile.preferences };
  appearance = { theme, preferences };
  const time = new Date().toTimeString().slice(0, 5);
  const schedule = preferences.schedule;
  const daylight = schedule && (schedule.light < schedule.dark
    ? time >= schedule.light && time < schedule.dark : time >= schedule.light || time < schedule.dark);
  const automaticLight = preferences.automatic === "light" ||
    (preferences.automatic === "system" && (schedule ? daylight : !dark.matches));
  const paletteId = theme === "auto" ? (automaticLight ? "arctic-light" : "midnight-purple") : theme;
  const palette = custom || themes.find(item => item.id === paletteId) || themes[0];
  setPalette(root, palette);
  root.dataset.palette = palette.id;
  root.dataset.scheme = palette.light ? "light" : "dark";
  Object.assign(root.dataset, { density: custom?.density || preferences.density, focus: preferences.focus ? "on" : "off",
    motion: preferences.motion === "system" ? custom?.motion || "system" : preferences.motion,
    textSize: preferences.text === "standard" ? custom?.textSize || "standard" : preferences.text,
    effects: preferences.effects ? "on" : "off", shadows: custom?.shadows || "on",
    highContrast: preferences.highContrast ? "on" : "off" });
  document.body.dataset.theme = theme;
}
dark.addEventListener("change", () => { if (appearance.theme === "auto") applyAppearance(appearance); });
setInterval(() => {
  if (appearance.theme === "auto" && appearance.preferences.schedule) applyAppearance(appearance);
}, 15000);

export function mountAppearance(container, endpoint, initial) {
  if (container.dataset.ready) return;
  container.dataset.ready = "true";
  let saved = { theme: initial.theme || defaultTheme,
    preferences: { ...defaultPreferences, ...initial.preferences } };
  let revision = initial.appearance_revision;
  let filter = "all";
  let saving = false;
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const filters = make("div", "", "appearance-filters");
  const grid = make("div", "", "appearance-grid");
  const settings = make("div", "", "appearance-settings");
  const status = make("p", "", "appearance-status");
  status.setAttribute("role", "status");
  const cards = [];
  const filterButtons = [];
  const controls = [];
  const options = [
    { id: "auto", name: "Автоматически" },
    { ...themes[0], id: defaultTheme, name: "Quantum Purple" },
    ...themes
  ];
  for (const [id, name] of [["all", "Все"], ["dark", "Тёмные"], ["light", "Светлые"], ["mine", "Мои"], ["favorites", "Избранные"]]) {
    const button = make("button", name, "secondary");
    button.type = "button";
    button.addEventListener("click", () => { filter = id; render(); });
    filters.append(button);
    filterButtons.push({ id, button });
  }
  function sample(palette) {
    const preview = make("span", "", "appearance-preview");
    setPalette(preview, palette);
    const sidebar = make("span", "", "appearance-mini-sidebar");
    sidebar.append(make("i"), make("i"), make("i"));
    const card = make("span", "", "appearance-miniature");
    card.append(make("strong", "Карточка"), make("span", "Пример текста", "appearance-mini-muted"),
      make("span", "Ссылка", "appearance-mini-link"), make("span", "Кнопка", "appearance-sample"));
    preview.append(sidebar, card);
    return preview;
  }

  function choose(id) {
    if (!id || id === saved.theme) return;
    const recentThemes = [id, saved.theme, ...(saved.preferences.recentThemes || [])];
    save({ theme: id, preferences: { ...saved.preferences, recentThemes: [...new Set(recentThemes)].slice(0, 6) } });
  }

  function action(label, handler) {
    const control = make("button", label, "secondary");
    control.type = "button";
    control.onclick = handler;
    return control;
  }

  function addCard(option) {
    const button = make("button", "", "appearance-card");
    button.type = "button";
    button.setAttribute("aria-label", option.name);
    button.dataset.themeId = option.id;
    const preview = sample(option.colors ? option : themes[0]);
    preview.setAttribute("aria-hidden", "true");
    button.append(preview, make("span", option.name, "appearance-name"),
      make("small", option.colors ? (option.light ? "Светлая" : "Тёмная") : "По системе или расписанию", "appearance-kind"));
    button.addEventListener("click", () => choose(option.id));
    const tile = make("div", "", "appearance-tile");
    const favorite = make("button", "☆", "secondary appearance-favorite");
    favorite.type = "button";
    favorite.setAttribute("aria-label", "Избранное — " + option.name);
    favorite.addEventListener("click", () => {
      const values = saved.preferences.favorites || [];
      const favorites = values.includes(option.id) ? values.filter(id => id !== option.id) : [...values, option.id];
      save({ ...saved, preferences: { ...saved.preferences, favorites } });
    });
    tile.append(button, favorite);
    const custom = () => normalizeCustomTheme(saved.preferences.customThemes?.find(item => item.id === option.id));
    if (option.id.startsWith("custom-")) {
      tile.append(action("Изменить", () => openEditor(custom(), option.id)),
        action("Дублировать", () => openEditor(custom())), action("Экспорт JSON", () => downloadTheme(custom())));
    } else if (option.colors) tile.append(action("Взять за основу", () => openEditor(themeDraft(option))));
    grid.append(tile);
    cards.push({ option, button, tile, favorite });
  }
  function setting(key, labelText, values) {
    const label = make("label", labelText);
    const select = make("select");
    for (const [key, name] of values) select.add(new Option(name, key));
    select.addEventListener("change", () => save({ ...saved, preferences: {
      ...saved.preferences, [key]: ["effects", "focus", "highContrast"].includes(key) ? select.value === "on" : select.value
    } }));
    controls.push({ key, select, label });
    label.append(select);
    settings.append(label);
  }
  setting("density", "Плотность интерфейса", [["comfortable", "Просторная"], ["compact", "Компактная"]]);
  setting("motion", "Анимации", [["system", "Как в системе"], ["reduce", "Минимальные"], ["none", "Отключены"]]);
  setting("automatic", "Палитра в автоматическом режиме", [["system", "Как в системе"], ["light", "Светлая"], ["dark", "Тёмная"]]);
  setting("text", "Размер текста", [["small", "Маленький"], ["standard", "Стандартный"], ["large", "Крупный"]]);
  setting("effects", "Декоративные эффекты", [["on", "Включены"], ["off", "Отключены"]]);
  setting("focus", "Режим фокусировки", [["off", "Отключён"], ["on", "Включён"]]);
  setting("highContrast", "Усиленный контраст", [["off", "Отключён"], ["on", "Включён"]]);
  const search = make("input");
  search.type = "search";
  search.placeholder = "Поиск тем";
  search.setAttribute("aria-label", "Поиск тем");
  search.addEventListener("input", () => render());
  const sort = make("select");
  sort.setAttribute("aria-label", "Сортировка тем");
  sort.add(new Option("По каталогу", "catalog"));
  sort.add(new Option("По названию А–Я", "asc"));
  sort.add(new Option("По названию Я–А", "desc"));
  sort.onchange = () => render();
  const recent = make("select");
  recent.setAttribute("aria-label", "Недавние темы");
  recent.onchange = () => choose(recent.value);
  const empty = make("p", "Темы не найдены.", "appearance-kind");
  const random = action("Случайная тема", () => {
    const available = themes.filter(theme => theme.id !== saved.theme);
    choose(available[Math.floor(Math.random() * available.length)].id);
  });
  const create = make("button", "Создать свою тему", "secondary");
  create.type = "button";
  create.addEventListener("click", () => openEditor());
  const reset = make("button", "Восстановить стандартные настройки", "secondary");
  reset.type = "button";
  reset.addEventListener("click", () => save({ theme: defaultTheme, preferences: { ...defaultPreferences,
    customThemes: saved.preferences.customThemes, favorites: saved.preferences.favorites } }));
  // The personalization block can be mounted inside the existing profile form.
  const editorPanel = make("section", "", "appearance-editor");
  editorPanel.hidden = true;
  const importFile = make("input");
  importFile.type = "file";
  importFile.accept = ".json,application/json";
  importFile.hidden = true;
  importFile.onchange = async () => {
    const file = importFile.files[0];
    importFile.value = "";
    if (!file) return;
    const draft = file.size <= 16384 && importTheme(await file.text().catch(() => ""));
    if (draft) openEditor(draft, undefined, true);
    else showError("Файл не содержит допустимую тему RPM.");
  };
  const importButton = action("Импорт JSON", () => importFile.click());
  const schedule = make("div", "", "appearance-schedule");
  const times = Object.fromEntries([["light", "Светлая с"], ["dark", "Тёмная с"]].map(([key, label]) => {
    const field = make("label", label);
    const input = make("input");
    input.type = "time";
    field.append(input);
    schedule.append(field);
    return [key, input];
  }));
  schedule.append(action("Сохранить расписание", () => {
    if (!times.light.value || !times.dark.value || times.light.value === times.dark.value) {
      showError("Укажите два разных времени для переключения темы.");
      return;
    }
    save({ theme: "auto", preferences: { ...saved.preferences, automatic: "system", schedule: {
      light: times.light.value, dark: times.dark.value
    } } });
  }), action("По настройке устройства", () => {
    const { schedule: previous, ...preferences } = saved.preferences;
    save({ theme: "auto", preferences: { ...preferences, automatic: "system" } });
  }));
  const toolbar = make("div", "", "appearance-toolbar");
  toolbar.append(search, sort, recent, random, create, importButton, importFile);
  container.append(make("h2", "Персонализация"), toolbar, filters, editorPanel, grid, empty, settings, schedule, reset, status);

  function showError(message) {
    status.dataset.error = "true";
    status.textContent = message;
  }

  function downloadTheme(theme) {
    const json = exportTheme(theme);
    if (!json) return;
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = make("a");
    link.href = url;
    link.download = "rpm-theme.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openEditor(source, existingId, imported = false) {
    editorPanel.hidden = false;
    editorPanel.replaceChildren();
    const heading = make("h3", imported ? "Предпросмотр импорта" : existingId ? "Редактирование темы" : "Новая тема");
    const fields = make("div", "", "appearance-settings");
    editorPanel.append(heading, fields);
    const original = source || { ...themeDraft(), name: "Моя тема" };
    const id = existingId || "custom-" + crypto.randomUUID();
    const occupied = () => new Set([...options, ...(saved.preferences.customThemes || [])]
      .filter(theme => theme.id !== existingId).map(theme => theme.name.toLowerCase()));
    const names = occupied();
    let suggested = original.name;
    for (let number = 2; !existingId && names.has(suggested.toLowerCase()); number++) {
      const suffix = " (" + number + ")";
      suggested = original.name.slice(0, 40 - suffix.length) + suffix;
    }
    const field = (title, type, value) => {
      const label = make("label", title);
      const input = make("input");
      input.type = type;
      input.value = value;
      label.append(input);
      fields.append(label);
      return input;
    };
    const name = field("Название", "text", suggested);
    name.maxLength = 40;
    const colors = Object.fromEntries(Object.entries(themeColorLabels).map(([key, title]) =>
      [key, field(title, "color", original.colors[key])]));
    const radii = Object.fromEntries([["cardRadius", "Скругление карточек"], ["buttonRadius", "Скругление кнопок"]]
      .map(([key, title]) => {
        const input = field(title, "number", original[key]);
        input.min = 0;
        input.max = 32;
        return [key, input];
      }));
    const preferences = Object.fromEntries(Object.entries({
      density: "Плотность темы", text: "Размер шрифта темы", motion: "Анимации темы", shadows: "Тени"
    }).map(([key, title]) => {
      const label = make("label", title);
      const select = make("select");
      for (const [value, text] of themeControls[key]) select.add(new Option(text, value));
      select.value = original[key];
      label.append(select);
      fields.append(label);
      return [key, select];
    }));
    const preview = make("div", "", "appearance-editor-preview");
    const warning = make("p");
    warning.setAttribute("role", "status");
    const saveButton = make("button", imported ? "Импортировать тему" : "Сохранить тему", "primary");
    saveButton.type = "button";
    const cancel = make("button", "Закрыть", "secondary");
    cancel.type = "button";
    cancel.onclick = () => { editorPanel.hidden = true; };
    editorPanel.append(preview, warning, saveButton, cancel);
    if (suggested !== original.name) editorPanel.append(make("p", "Название уже занято. Предложено новое название."));
    const values = fields => Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value]));
    const read = () => ({ id, name: name.value, colors: values(colors), ...values(preferences),
      ...Object.fromEntries(Object.entries(radii).map(([key, input]) => [key, input.valueAsNumber])) });
    const refresh = () => {
      const data = read();
      const palette = customPalette(data);
      const { background, surface, muted, accent, text, border, button, sidebar, selection, link, input } = data.colors;
      preview.replaceChildren(sample(palette || { colors: [background, surface, selection, text, muted, accent, accent,
        border, input, "#ffffff"], button, sidebar, link, cardRadius: data.cardRadius, buttonRadius: data.buttonRadius }));
      Object.assign(preview.dataset, { density: data.density, text: data.text, motion: data.motion, shadows: data.shadows });
      const duplicate = occupied().has(name.value.trim().toLowerCase());
      saveButton.disabled = !palette || duplicate;
      warning.textContent = duplicate ? "Тема с таким названием уже есть." : palette ? "" :
        "Проверьте название, скругления и контраст текста, ссылок и акцента. Требуется не менее 4,5:1.";
    };
    fields.oninput = refresh;
    editorPanel.append(action("Восстановить исходные настройки", () => {
      name.value = suggested;
      for (const [key, input] of Object.entries(colors)) input.value = original.colors[key];
      for (const [key, input] of Object.entries({ ...radii, ...preferences })) input.value = original[key];
      refresh();
    }));
    saveButton.onclick = async () => {
      refresh();
      if (saveButton.disabled) return;
      const customThemes = [...(saved.preferences.customThemes || []).filter(item => item.id !== id), read()];
      if (customThemes.length > 12) { warning.textContent = "Можно сохранить до 12 тем."; return; }
      if (await save({ theme: id, preferences: { ...saved.preferences, customThemes } })) {
        editorPanel.hidden = true;
        filter = "all";
        search.value = "";
        render();
      }
    };
    if (existingId) {
      const remove = make("button", "Удалить тему", "secondary");
      remove.type = "button";
      remove.onclick = async () => {
        if (!window.confirm("Удалить тему «" + original.name + "»?")) return;
        const customThemes = saved.preferences.customThemes.filter(item => item.id !== id);
        const favorites = (saved.preferences.favorites || []).filter(item => item !== id);
        const recentThemes = (saved.preferences.recentThemes || []).filter(item => item !== id);
        const theme = saved.theme === id ? defaultTheme : saved.theme;
        if (await save({ theme, preferences: { ...saved.preferences, customThemes, favorites, recentThemes } })) editorPanel.hidden = true;
      };
      editorPanel.append(remove);
    }
    refresh();
    name.focus();
  }
  options.forEach(addCard);
  let renderedCustom;

  function render(current = saved) {
    if (renderedCustom !== current.preferences.customThemes) {
      while (cards.length > options.length) cards.pop().tile.remove();
      renderedCustom = current.preferences.customThemes;
      (renderedCustom || []).map(customPalette).filter(Boolean).forEach(addCard);
    }
    const displayed = [...cards];
    if (sort.value !== "catalog") displayed.sort((a, b) =>
      a.option.name.localeCompare(b.option.name, "ru") * (sort.value === "asc" ? 1 : -1));
    // Keep the focused card in place when only its state changes.
    if (displayed.some(({ tile }, index) => grid.children[index] !== tile)) {
      for (const { tile } of displayed) grid.append(tile);
    }
    for (const { option, button, tile, favorite } of cards) {
      const starred = (current.preferences.favorites || []).includes(option.id);
      tile.hidden = !option.name.toLowerCase().includes(search.value.trim().toLowerCase()) ||
        (filter === "favorites" ? !starred : filter === "mine" ? !option.id.startsWith("custom-") :
          filter !== "all" && (!option.colors || option.light !== (filter === "light")));
      favorite.textContent = starred ? "★" : "☆";
      favorite.setAttribute("aria-pressed", String(starred));
      favorite.disabled = saving;
      button.disabled = saving;
      button.setAttribute("aria-pressed", String(option.id === current.theme));
    }
    empty.hidden = cards.some(({ tile }) => !tile.hidden);
    recent.replaceChildren(new Option("Недавние темы", ""));
    for (const id of current.preferences.recentThemes || []) {
      const card = cards.find(({ option }) => option.id === id);
      if (card) recent.add(new Option(card.option.name, id));
    }
    recent.disabled = saving || recent.options.length < 2;
    random.disabled = saving;
    for (const { id, button } of filterButtons) button.setAttribute("aria-pressed", String(filter === id));
    for (const { key, select, label } of controls) {
      label.hidden = key === "automatic" && current.theme !== "auto";
      select.disabled = saving;
      select.value = ["effects", "focus", "highContrast"].includes(key) ? (current.preferences[key] ? "on" : "off") : current.preferences[key];
    }
    schedule.hidden = current.theme !== "auto";
    times.light.value = current.preferences.schedule?.light || "07:00";
    times.dark.value = current.preferences.schedule?.dark || "20:00";
  }

  async function save(next) {
    if (saving || JSON.stringify(next) === JSON.stringify(saved)) return;
    const focus = document.activeElement;
    saving = true;
    delete status.dataset.error;
    status.textContent = "Сохранение оформления…";
    applyAppearance(next);
    render(next);
    let conflict = false;
    try {
      const headers = { "Content-Type": "application/json", ...(revision && { "If-Match": '"' + revision + '"' }) };
      const response = await fetch(endpoint, { method: "PATCH", headers,
        body: JSON.stringify(next), signal: AbortSignal.timeout(12000) });
      conflict = response.status === 409;
      if (!response.ok) throw new Error("Appearance update failed");
      saved = (await response.json()).appearance;
      revision = response.headers.get("ETag")?.replaceAll('"', "");
      rememberAppearance(saved);
      updates.postMessage("profile-changed");
      status.textContent = "Оформление сохранено.";
      return true;
    } catch {
      showError(conflict ? "Оформление изменилось в другой вкладке или на другом устройстве. Проверьте настройки и повторите действие." :
        "Не удалось сохранить оформление. Восстановлены прежние настройки.");
    } finally {
      saving = false;
      applyAppearance(saved);
      render();
      if (conflict) void refreshMounted();
      if (document.activeElement === document.body && container.contains(focus) && !focus.closest("[hidden]")) focus.focus({ preventScroll: true });
    }
  }
  refreshMounted = async () => {
    if (saving) return;
    const previous = revision;
    const profile = await readProfile(endpoint === "/api/customer/profile" ? endpoint : "/api/panel/profile");
    if (!profile || saving || previous !== revision || previous === profile.appearance_revision) return;
    saved = { theme: profile.theme || defaultTheme, preferences: { ...defaultPreferences, ...profile.preferences } };
    revision = profile.appearance_revision;
    applyAppearance(saved);
    rememberAppearance(saved);
    render();
  };
  applyAppearance(saved);
  rememberAppearance(saved);
  render();
}

export function rememberAppearance(profile) {
  try {
    sessionStorage.setItem("rpm-appearance", JSON.stringify({ theme: isTheme(profile.theme) ? profile.theme : defaultTheme }));
  } catch {}
}

async function readProfile(endpoint = "/api/panel/profile") {
  try {
    const response = await fetch(endpoint, { cache: "no-store" });
    if (response.ok) return (await response.json()).profile;
  } catch {}
}

async function refreshAppearance() {
  if (refreshMounted) return refreshMounted();
  if (document.body.hasAttribute("data-appearance-cache")) return;
  const profile = await readProfile();
  if (profile && !refreshMounted) {
    applyAppearance(profile);
    rememberAppearance(profile);
  }
}

updates.addEventListener("message", refreshAppearance);
window.addEventListener("focus", refreshAppearance);
if (document.body.hasAttribute("data-appearance-cache")) {
  try {
    const { theme } = JSON.parse(sessionStorage.getItem("rpm-appearance") || "{}");
    applyAppearance({ theme });
    rememberAppearance({ theme });
  } catch {}
}
if (document.body.hasAttribute("data-panel-appearance")) {
  void refreshAppearance();
}
