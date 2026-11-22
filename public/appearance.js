import { defaultTheme, defaultPreferences, themes, isTheme, customPalette } from "./theme-catalog.js";

const root = document.documentElement;
const dark = matchMedia("(prefers-color-scheme: dark)");
const tokens = ["bg", "surface", "surface-hover", "text", "text-muted", "accent", "accent-hover", "border", "input-bg", "accent-text"];
let appearance = { theme: defaultTheme, preferences: defaultPreferences };

function setPalette(node, palette) {
  tokens.forEach((token, index) => node.style.setProperty("--" + token, palette.colors[index]));
  node.style.setProperty("--button-bg", palette.button || palette.colors[5]);
  node.style.setProperty("--custom-radius", palette.radius == null ? "" : palette.radius + "px");
  node.style.colorScheme = palette.light ? "light" : "dark";
}

export function applyAppearance(profile = {}) {
  const custom = profile.preferences?.customThemes?.map(customPalette).find(item => item?.id === profile.theme);
  const theme = isTheme(profile.theme) || custom ? profile.theme : defaultTheme;
  const preferences = { ...defaultPreferences, ...profile.preferences };
  appearance = { theme, preferences };
  const automaticLight = preferences.automatic === "light" || (preferences.automatic === "system" && !dark.matches);
  const paletteId = theme === "auto" ? (automaticLight ? "arctic-light" : "midnight-purple") : theme;
  const palette = custom || themes.find(item => item.id === paletteId) || themes[0];
  setPalette(root, palette);
  root.dataset.palette = palette.id;
  root.dataset.scheme = palette.light ? "light" : "dark";
  Object.assign(root.dataset, { density: custom?.density || preferences.density, focus: preferences.focus ? "on" : "off", motion: preferences.motion,
    textSize: preferences.text, effects: preferences.effects ? "on" : "off" });
  document.body.dataset.theme = theme;
}
dark.addEventListener("change", () => { if (appearance.theme === "auto") applyAppearance(appearance); });

export function mountAppearance(container, endpoint, initial) {
  if (container.dataset.ready) return;
  container.dataset.ready = "true";
  let saved = { theme: initial.theme || defaultTheme,
    preferences: { ...defaultPreferences, ...initial.preferences } };
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
  for (const [id, name] of [["all", "Все"], ["dark", "Тёмные"], ["light", "Светлые"], ["favorites", "Избранные"]]) {
    const button = make("button", name, "secondary");
    button.type = "button";
    button.addEventListener("click", () => { filter = id; render(); });
    filters.append(button);
    filterButtons.push({ id, button });
  }
  function addCard(option) {
    const button = make("button", "", "appearance-card");
    button.type = "button";
    button.setAttribute("aria-label", option.name);
    button.dataset.themeId = option.id;
    const preview = make("span", "", "appearance-preview");
    setPalette(preview, option.colors ? option : themes[0]);
    preview.setAttribute("aria-hidden", "true");
    const miniature = make("span", "RPM", "appearance-miniature");
    miniature.append(make("i"));
    const swatches = make("span", "", "appearance-swatches");
    for (const color of ["bg", "surface", "accent", "text"]) {
      const swatch = make("i");
      swatch.style.background = "var(--" + color + ")";
      swatches.append(swatch);
    }
    preview.append(miniature, swatches);
    button.append(preview, make("span", option.name, "appearance-name"));
    button.addEventListener("click", () => save({ ...saved, theme: option.id }));
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
    if (option.id.startsWith("custom-")) {
      const edit = make("button", "Изменить", "secondary");
      edit.type = "button";
      edit.addEventListener("click", () => openEditor(saved.preferences.customThemes.find(item => item.id === option.id)));
      tile.append(edit);
    }
    grid.append(tile);
    cards.push({ option, button, tile, favorite });
  }
  function setting(key, labelText, values) {
    const label = make("label", labelText);
    const select = make("select");
    for (const [key, name] of values) select.add(new Option(name, key));
    select.addEventListener("change", () => save({ ...saved, preferences: {
      ...saved.preferences, [key]: ["effects", "focus"].includes(key) ? select.value === "on" : select.value
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
  const search = make("input");
  search.type = "search";
  search.placeholder = "Поиск тем";
  search.setAttribute("aria-label", "Поиск тем");
  search.addEventListener("input", () => render());
  const create = make("button", "Создать свою тему", "secondary");
  create.type = "button";
  create.addEventListener("click", () => openEditor());
  const reset = make("button", "Восстановить стандартные настройки", "secondary");
  reset.type = "button";
  reset.addEventListener("click", () => save({ theme: defaultTheme, preferences: { ...defaultPreferences,
    customThemes: saved.preferences.customThemes, favorites: saved.preferences.favorites } }));
  // The personalization block can be mounted inside the existing profile form.
  const editorPanel = make("div", "", "appearance-settings");
  editorPanel.hidden = true;
  container.append(make("h2", "Персонализация"), search, filters, grid, create, reset, editorPanel, settings, status);

  function openEditor(custom) {
    editorPanel.hidden = false;
    editorPanel.replaceChildren();
    const field = (title, type, value) => {
      const label = make("label", title);
      const input = make("input");
      input.type = type;
      input.value = value;
      label.append(input);
      editorPanel.append(label);
      return input;
    };
    const name = field("Название", "text", custom?.name || "Моя тема");
    name.maxLength = 40;
    const colorFields = ["Фон", "Карточки", "Акцент", "Текст", "Границы", "Кнопки"].map((label, index) =>
      field(label, "color", (custom?.colors || ["#08090b", "#17191e", "#b6bdcc", "#f1f2f4", "#343943", "#b6bdcc"])[index]));
    const radius = field("Скругление", "range", "");
    radius.min = 0;
    radius.max = 24;
    radius.value = custom?.radius ?? 8;
    const density = make("select");
    density.setAttribute("aria-label", "Плотность собственной темы");
    density.add(new Option("Комфортная", "comfortable"));
    density.add(new Option("Компактная", "compact"));
    density.value = custom?.density || "comfortable";
    editorPanel.append(density);
    const preview = make("div", "Предпросмотр текста", "appearance-preview");
    const buttonSample = make("span", "Кнопка", "appearance-sample");
    preview.append(buttonSample);
    const warning = make("p");
    warning.setAttribute("role", "status");
    const saveButton = make("button", "Сохранить тему", "primary");
    saveButton.type = "button";
    const cancel = make("button", "Закрыть", "secondary");
    cancel.type = "button";
    cancel.onclick = () => { editorPanel.hidden = true; };
    editorPanel.append(preview, warning, saveButton, cancel);
    const id = custom?.id || "custom-" + crypto.randomUUID();
    const read = () => ({ id, name: name.value, colors: colorFields.map(input => input.value),
      radius: Number(radius.value), density: density.value });
    const refresh = () => {
      const data = read();
      const palette = customPalette(data);
      const [bg, surface, accent, text, border, button] = data.colors;
      setPalette(preview, palette || { colors: [bg, surface, bg, text, text, accent, accent, border, bg, "#ffffff"], button, radius: data.radius });
      saveButton.disabled = !palette;
      warning.textContent = palette ? "" : "Проверьте название и контраст текста и акцента. Требуется не менее 4,5:1.";
    };
    for (const control of [name, ...colorFields, radius, density]) control.oninput = refresh;
    saveButton.onclick = async () => {
      const customThemes = [...(saved.preferences.customThemes || []).filter(item => item.id !== id), read()];
      if (customThemes.length > 12) { warning.textContent = "Можно сохранить до 12 тем."; return; }
      if (await save({ theme: id, preferences: { ...saved.preferences, customThemes } })) {
        editorPanel.hidden = true;
        filter = "all";
        search.value = "";
        render();
      }
    };
    if (custom) {
      const remove = make("button", "Удалить тему", "secondary");
      remove.type = "button";
      remove.onclick = async () => {
        const customThemes = saved.preferences.customThemes.filter(item => item.id !== id);
        const favorites = (saved.preferences.favorites || []).filter(item => item !== id);
        const theme = saved.theme === id ? defaultTheme : saved.theme;
        if (await save({ theme, preferences: { ...saved.preferences, customThemes, favorites } })) editorPanel.hidden = true;
      };
      editorPanel.append(remove);
    }
    refresh();
  }
  options.forEach(addCard);
  let renderedCustom;

  function render(current = saved) {
    if (renderedCustom !== current.preferences.customThemes) {
      while (cards.length > options.length) cards.pop().tile.remove();
      renderedCustom = current.preferences.customThemes;
      (renderedCustom || []).map(customPalette).filter(Boolean).forEach(addCard);
    }
    for (const { option, button, tile, favorite } of cards) {
      const starred = (current.preferences.favorites || []).includes(option.id);
      tile.hidden = !option.name.toLowerCase().includes(search.value.trim().toLowerCase()) ||
        (filter === "favorites" ? !starred : filter !== "all" && (!option.colors || option.light !== (filter === "light")));
      favorite.textContent = starred ? "★" : "☆";
      favorite.setAttribute("aria-pressed", String(starred));
      favorite.disabled = saving;
      button.disabled = saving;
      button.setAttribute("aria-pressed", String(option.id === current.theme));
    }
    for (const { id, button } of filterButtons) button.setAttribute("aria-pressed", String(filter === id));
    for (const { key, select, label } of controls) {
      label.hidden = key === "automatic" && current.theme !== "auto";
      select.disabled = saving;
      select.value = ["effects", "focus"].includes(key) ? (current.preferences[key] ? "on" : "off") : current.preferences[key];
    }
  }

  async function save(next) {
    if (saving || JSON.stringify(next) === JSON.stringify(saved)) return;
    const focus = document.activeElement;
    saving = true;
    delete status.dataset.error;
    status.textContent = "Сохранение оформления…";
    applyAppearance(next);
    render(next);
    try {
      const response = await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next), signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error("Appearance update failed");
      saved = (await response.json()).appearance;
      rememberAppearance(saved);
      status.textContent = "Оформление сохранено.";
      return true;
    } catch {
      status.dataset.error = "true";
      status.textContent = "Не удалось сохранить оформление. Восстановлены прежние настройки.";
    } finally {
      saving = false;
      applyAppearance(saved);
      render();
      if (document.activeElement === document.body && container.contains(focus) && !focus.closest("[hidden]")) focus.focus({ preventScroll: true });
    }
  }
  applyAppearance(saved);
  rememberAppearance(saved);
  render();
}

export function rememberAppearance(profile) {
  try { sessionStorage.setItem("rpm-appearance", JSON.stringify({ theme: profile.theme, preferences: profile.preferences })); } catch {}
}

if (document.body.hasAttribute("data-appearance-cache")) {
  try { applyAppearance(JSON.parse(sessionStorage.getItem("rpm-appearance") || "{}")); } catch {}
}
if (document.body.hasAttribute("data-panel-appearance")) {
  fetch("/api/panel/profile").then(response => response.ok ? response.json() : null)
    .then(data => { if (data?.profile) applyAppearance(data.profile); }).catch(() => {});
}
