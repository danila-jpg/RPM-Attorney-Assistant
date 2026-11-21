import { defaultTheme, defaultPreferences, themes, isTheme } from "./theme-catalog.js";

const root = document.documentElement;
const dark = matchMedia("(prefers-color-scheme: dark)");
const tokens = ["bg", "surface", "surface-hover", "text", "text-muted", "accent", "accent-hover", "border", "input-bg", "accent-text"];
let appearance = { theme: defaultTheme, preferences: defaultPreferences };

function setPalette(node, palette) {
  tokens.forEach((token, index) => node.style.setProperty("--" + token, palette.colors[index]));
  node.style.colorScheme = palette.light ? "light" : "dark";
}

export function applyAppearance(profile = {}) {
  const theme = isTheme(profile.theme) ? profile.theme : defaultTheme;
  const preferences = { ...defaultPreferences, ...profile.preferences };
  appearance = { theme, preferences };
  const automaticLight = preferences.automatic === "light" || (preferences.automatic === "system" && !dark.matches);
  const paletteId = theme === "auto" ? (automaticLight ? "arctic-light" : "midnight-purple") : theme;
  const palette = themes.find(item => item.id === paletteId) || themes[0];
  setPalette(root, palette);
  root.dataset.palette = palette.id;
  root.dataset.scheme = palette.light ? "light" : "dark";
  Object.assign(root.dataset, { density: preferences.density, motion: preferences.motion,
    textSize: preferences.text, effects: preferences.effects ? "on" : "off" });
  document.body.dataset.theme = theme;
}
dark.addEventListener("change", () => { if (appearance.theme === "auto") applyAppearance(appearance); });

export function mountAppearance(container, endpoint, initial) {
  if (container.dataset.ready) return;
  container.dataset.ready = "true";
  let saved = { theme: isTheme(initial.theme) ? initial.theme : defaultTheme,
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
  for (const [id, name] of [["all", "Все"], ["dark", "Тёмные"], ["light", "Светлые"]]) {
    const button = make("button", name, "secondary");
    button.type = "button";
    button.addEventListener("click", () => { filter = id; render(); });
    filters.append(button);
    filterButtons.push({ id, button });
  }
  for (const option of options) {
    const button = make("button", "", "appearance-card");
    button.type = "button";
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
    grid.append(button);
    cards.push({ option, button });
  }
  function setting(key, labelText, values) {
    const label = make("label", labelText);
    const select = make("select");
    for (const [key, name] of values) select.add(new Option(name, key));
    select.addEventListener("change", () => save({ ...saved, preferences: {
      ...saved.preferences, [key]: key === "effects" ? select.value === "on" : select.value
    } }));
    controls.push({ key, select, label });
    label.append(select);
    settings.append(label);
  }
  setting("density", "Плотность интерфейса", [["comfortable", "Просторная"], ["compact", "Компактная"]]);
  setting("motion", "Анимации", [["system", "Как в системе"], ["reduce", "Уменьшить"]]);
  setting("automatic", "Палитра в автоматическом режиме", [["system", "Как в системе"], ["light", "Светлая"], ["dark", "Тёмная"]]);
  setting("text", "Размер текста", [["standard", "Стандартный"], ["large", "Увеличенный"]]);
  setting("effects", "Декоративные эффекты", [["on", "Включены"], ["off", "Отключены"]]);
  container.append(make("h2", "Оформление"), filters, grid, settings, status);

  function render(current = saved) {
    for (const { option, button } of cards) {
      button.hidden = filter !== "all" && (!option.colors || option.light !== (filter === "light"));
      button.disabled = saving;
      button.setAttribute("aria-pressed", String(option.id === current.theme));
    }
    for (const { id, button } of filterButtons) button.setAttribute("aria-pressed", String(filter === id));
    for (const { key, select, label } of controls) {
      label.hidden = key === "automatic" && current.theme !== "auto";
      select.disabled = saving;
      select.value = key === "effects" ? (current.preferences.effects ? "on" : "off") : current.preferences[key];
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
