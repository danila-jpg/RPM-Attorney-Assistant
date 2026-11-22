export const defaultTheme = "quantum-purple";
export const defaultPreferences = Object.freeze({
  density: "comfortable", motion: "system", automatic: "system", text: "standard", effects: true
});

const palette = (id, name, colors, light = false) => ({ id, name, colors: colors.split(" "), light });
// Background, surface, hover, text, muted text, accent, accent hover, border, input, button text.
export const themes = [
  palette("midnight-purple", "Midnight Purple", "#090711 #151121 #211832 #f1eafa #aa9cbd #a16df2 #c49aff #39294f #0e0b17 #140924"),
  palette("graphite", "Graphite Pro", "#08090b #17191e #22252c #f1f2f4 #a0a5af #b6bdcc #d1d7e1 #343943 #101216 #101216"),
  palette("amoled-black", "AMOLED Black", "#000000 #0d0d0d #1c1c1c #ffffff #bdbdbd #dedede #ffffff #363636 #080808 #000000"),
  palette("obsidian", "Obsidian", "#090c11 #141922 #202936 #eef4fc #a5b3c7 #93aee0 #b8cef1 #344257 #0f141c #101827"),
  palette("royal-blue", "Royal Blue", "#091225 #122341 #1a3157 #eff6ff #a8bddb #8bbcff #acd1ff #365785 #0e1a30 #101e38"),
  palette("ocean", "Ocean Depths", "#07151d #102731 #193942 #e9fbfc #a0c4ca #64dbd1 #93eee7 #2c5661 #0b1e27 #092325"),
  palette("emerald", "Emerald", "#081811 #10271d #19392b #edf9f2 #acc7b7 #76e6ac #a1f2c5 #305a45 #0c2017 #0e2419"),
  palette("forest", "Forest Night", "#101711 #1b291d #283a29 #f3f6e9 #b5c3a7 #bbdb85 #d4eba7 #44573d #151f16 #192410"),
  palette("crimson", "Crimson", "#1b0d14 #2b1621 #41202e #fff0f5 #d4a9b8 #ff9db5 #ffbfd0 #683c4c #220f19 #36101d"),
  palette("sakura", "Sakura", "#fff4f7 #fffafd #f7e0ea #35232f #704c61 #942a5c #792049 #bb859e #fffafd #ffffff", true),
  palette("cyberpunk", "Cyberpunk Neon", "#100a1e #1b1230 #2a1b47 #faf1ff #c6aed9 #ec93ff #91f4ff #634487 #140e24 #200a2a"),
  palette("samurai", "Samurai", "#110e0e #211917 #362321 #fff1e6 #c8b1a4 #ffa390 #f5cf86 #63433b #181212 #301410"),
  palette("old-money", "Old Money", "#101a14 #1a2920 #293a2d #f5f1e3 #c4beaa #dec58d #f0d8a8 #535e46 #142118 #27200f"),
  palette("golden-noir", "Golden Noir", "#100d0a #201a14 #342919 #fff4e3 #cab79d #eac57b #ffdda0 #5a4830 #18130e #2b1a05"),
  palette("arctic-light", "Arctic", "#eef6fc #ffffff #dfeefa #142d45 #405f79 #195a92 #124674 #779ab6 #f7fbff #ffffff", true),
  palette("ivory", "Ivory", "#f8f1e4 #fffaf1 #efe1ca #38271b #6b5140 #82502b #633a1e #ad9174 #fffcf6 #ffffff", true),
  palette("minimal-light", "Minimal Light", "#f1f3f8 #ffffff #e8ebf3 #202638 #505e76 #5743b3 #44318d #8793aa #f8f9fc #ffffff", true),
  palette("cyber-blue", "Cyber Blue", "#061321 #102238 #18324d #e9f5ff #9db9d1 #73caff #a2deff #355c79 #091a2b #072136"),
  palette("sakura-night", "Sakura Night", "#1a111c #2d1e2e #442d44 #fff0f8 #cfb0c7 #f6aecd #ffcce1 #684960 #211421 #351728"),
  palette("tokyo-night", "Tokyo Night", "#161825 #202439 #2d3450 #eef0ff #afb8e0 #a8afff #c2caff #495578 #1a1e2d #191a37"),
  palette("imperial", "Imperial", "#190e20 #2b1733 #40234a #fff0f9 #d1b4d4 #e9bd79 #ffdda0 #74516e #231228 #321932"),
  palette("solarized-dark", "Solarized Dark", "#002b36 #073642 #104653 #eef2e6 #aec5c8 #8fd3db #b5e7e9 #476b70 #042e38 #052f38"),
  palette("nord", "Nord", "#232936 #2e3748 #3a4762 #eef4ff #bdc9e2 #a6dada #c2eeee #566988 #282f40 #243947"),
  palette("dracula", "Dracula", "#222230 #282a36 #3b3e52 #f8f8f2 #c9c7db #cba6ff #dfc5ff #62627e #232432 #211331"),
  palette("matrix", "Matrix", "#020804 #09150b #112719 #e2fbea #a2d6ad #69eb7e #a0ffaf #385c3e #060e08 #0c2412"),
  palette("sunset", "Sunset", "#1e1321 #33212e #4b2e3c #fff0ea #dbb3bd #ffb185 #ffd0aa #835562 #281826 #381926"),
  palette("lavender", "Lavender", "#f4eefc #fdf9ff #ebe0fa #302140 #615075 #693b9a #53277f #9e84b7 #fffaff #ffffff", true),
  palette("copper", "Copper Workshop", "#1f1710 #302318 #463224 #fff1df #dbc1a7 #ffc184 #ffd7ac #745640 #261c13 #321a0d"),
  palette("glacier", "Glacier", "#f0f7f7 #fcffff #daeeee #133738 #3e6261 #146563 #124e51 #739a9a #fbffff #ffffff", true),
  palette("plum", "Plum Velvet", "#220f19 #351827 #512739 #fff0f7 #dfb2c8 #ffa4c6 #ffd0e2 #7f4561 #2a1421 #401327"),
  palette("clay", "Terracotta", "#fff2e7 #fffaf5 #f1dece #44271e #6b4c3f #8d3e27 #70301e #ab8573 #fffaf5 #ffffff", true),
  palette("olive", "Olive Grove", "#171a0b #252a15 #393f24 #faf9df #cccea7 #dadd83 #edf3a5 #626746 #1d2110 #303311"),
  palette("ink", "Blue Ink", "#0b1023 #151f37 #233251 #edf1ff #b7c3e2 #98b3ff #c9d6ff #495b87 #0e172a #17223f"),
  palette("linen", "Linen", "#f5f5e9 #fffff7 #e9eadb #2f3423 #555e45 #485625 #313e16 #8c9274 #fdfdf1 #ffffff", true),
  palette("mulberry", "Mulberry", "#21142d #332043 #45315a #fff5ff #d3badf #eabcff #f5d7ff #775c88 #261832 #3c204d"),
  palette("stone", "Stone Slate", "#1a2021 #283032 #374548 #eef6f3 #b6c9c3 #afd9ca #c7f0e1 #556a66 #20292a #243631"),
  palette("citrus", "Citrus", "#fff8dc #fffff2 #f7eec0 #312a11 #665825 #6b5611 #53410b #9b8c48 #fffceb #ffffff", true),
  palette("eucalyptus", "Eucalyptus", "#eaf4ee #fbfffc #dcece2 #1d372b #456354 #23634b #174b37 #779b87 #fafffb #ffffff", true),
  palette("lavender-dream", "Lavender Dream", "#eee7fb #fbf6ff #e4d8f7 #30204d #584467 #64348b #492066 #8972a2 #faf4ff #ffffff", true),
  palette("royal-navy", "Royal Navy", "#080f20 #141e32 #202d45 #f1f5ff #bdc8da #d0ddf0 #e8effc #63718a #0c1627 #101d30"),
  palette("rose-gold", "Rose Gold", "#f8ede5 #fff7f1 #f1dfd7 #46292f #694853 #8a3f54 #713146 #9f746f #fffaf6 #ffffff", true),
  palette("cherry-blossom", "Cherry Blossom", "#fbe8ed #fffbfc #f8dce4 #471f31 #6f4556 #922f51 #70203c #a87388 #fff5f8 #ffffff", true),
  palette("deep-space", "Deep Space", "#05050e #101022 #1d1c38 #efefff #b6b3d8 #aaa1ff #d0c7ff #535184 #09091a #16102c"),
  palette("neon-city", "Neon City", "#0b1019 #151a2b #24213b #f7efff #d1b8d9 #6af3dd #ffa5ec #735986 #101425 #181026"),
  palette("moonlight", "Moonlight", "#101824 #1c2737 #29384d #f6f9ff #bfcbdf #c1d3eb #e3ecf8 #6a7f9b #151e2d #152132"),
  palette("white-marble", "White Marble", "#f2f3f5 #ffffff #e6e8eb #26282e #525761 #755717 #60440e #82858c #f9f9fa #ffffff", true),
  palette("coffee-house", "Coffee House", "#21150f #302019 #472e23 #fff3df #d9bb9c #edbf94 #ffe1bd #88644f #281911 #2c180f"),
  palette("dark-academia", "Dark Academia", "#191812 #25241a #363421 #f7edd4 #cbc39d #e4bd83 #f0d8a0 #756c49 #1e1c14 #29220f"),
  palette("vintage-paper", "Vintage Paper", "#f1e4c9 #fcf2db #e8d9b6 #402e1e #634b36 #754718 #5b3510 #8b7254 #fbedd1 #ffffff", true),
  palette("titanium", "Titanium", "#252a30 #313841 #3e4754 #f4f7fa #c6cfdb #9ed0ff #c2e0ff #6d7b8c #292f37 #172638"),
  palette("frost-glass", "Frost Glass", "#e0f0fa #f5fcff #d5e9f8 #18344b #405d76 #235b8a #174775 #6488a1 #f1faff #ffffff", true),
  palette("aurora-borealis", "Aurora Borealis", "#0a171b #12252b #203341 #f0fdfa #bdd2cf #8cf0c3 #d8b6ff #596e7d #0c1e24 #142727"),
  palette("blood-moon", "Blood Moon", "#190e13 #29191e #3e252b #fff2f0 #dbb7b8 #ff9c9e #ffbdba #895760 #211217 #351317"),
  palette("jade-dynasty", "Jade Dynasty", "#e9f2e8 #fcfaee #d8eadd #1c3831 #485c50 #18624e #594309 #688679 #f6fbf4 #ffffff", true),
  palette("desert-sand", "Desert Sand", "#f4e5cf #fff3df #ebd8bd #472d21 #67483c #853b26 #672b1d #96745d #fff4e6 #ffffff", true),
  palette("sakura-midnight", "Sakura Midnight", "#10152b #1c2340 #2d3050 #fff1fa #d2bfd7 #ffaecf #ffc8e3 #776289 #151a32 #3a1934"),
  palette("electric-violet", "Electric Violet", "#0c0712 #1b1029 #301c45 #faf1ff #d2bbeb #c998ff #e1c2ff #765493 #140b21 #251032"),
  palette("hacker-terminal", "Hacker Terminal", "#121617 #1b2121 #29312f #deefdf #b2c9b4 #9cdb9f #c0f4bf #657a68 #171d1b #132419"),
  palette("polar-night", "Polar Night", "#141f2a #202f3e #2e4050 #edf7ff #bccee0 #a7d9f1 #c9eaff #627e91 #182532 #172a38"),
  palette("champagne", "Champagne", "#f7f0dd #fffbef #eee3ca #3c301e #605038 #755119 #5f3e0d #8e795a #fdf7e8 #ffffff", true),
  palette("amethyst", "Amethyst", "#21132c #30203d #463454 #f7f0fc #d3c4df #c9b2ee #e5d9f7 #806c92 #281933 #2d1b3e")
];

export function isTheme(value) {
  return value === defaultTheme || value === "auto" || themes.some(theme => theme.id === value);
}

export function contrast(a, b) {
  const luminance = hex => hex.slice(1).match(/../g).map((pair, index) => {
    const channel = parseInt(pair, 16) / 255;
    return (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) *
      [0.2126, 0.7152, 0.0722][index];
  }).reduce((sum, channel) => sum + channel, 0);
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

export const themeColorLabels = {
  background: "Основной фон", sidebar: "Боковая панель", surface: "Фон карточек", text: "Основной текст",
  muted: "Второстепенный текст", accent: "Акцент", button: "Кнопки", border: "Границы",
  link: "Ссылки", selection: "Выделение", input: "Поля ввода"
};

export const themeControls = {
  density: [["comfortable", "Просторная"], ["compact", "Компактная"]],
  text: [["small", "Маленький"], ["standard", "Стандартный"], ["large", "Крупный"]],
  motion: [["system", "Как в системе"], ["reduce", "Минимальные"], ["none", "Отключены"]],
  shadows: [["on", "Включены"], ["off", "Отключены"]]
};

export function themeDraft(palette = themes[1]) {
  const [background, surface, hover, text, muted, accent, , border, input] = palette.colors;
  return {
    name: palette.name, colors: { background, sidebar: surface, surface, text, muted, accent,
      button: palette.button || accent, border, link: accent, selection: hover, input },
    cardRadius: 13, buttonRadius: 8, density: "comfortable", text: "standard", motion: "system", shadows: "on"
  };
}

const sameKeys = (record, shape) => record && typeof record === "object" && !Array.isArray(record) &&
  Object.keys(record).length === Object.keys(shape).length && Object.keys(shape).every(key => Object.hasOwn(record, key));

function normalizeDraft(draft) {
  if (!sameKeys(draft, themeDraft()) || typeof draft.name !== "string" || !draft.name.trim() ||
      draft.name.length > 40 || /[\u0000-\u001f\u007f]/.test(draft.name) ||
      !sameKeys(draft.colors, themeColorLabels) ||
      !Object.values(draft.colors).every(color => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) ||
      ![draft.cardRadius, draft.buttonRadius].every(radius => Number.isInteger(radius) && radius >= 0 && radius <= 32) ||
      !Object.entries(themeControls).every(([key, values]) => values.some(([value]) => draft[key] === value))) return null;
  const { background, sidebar, surface, input, selection, text, muted, accent, link } = draft.colors;
  if ([background, sidebar, surface, input, selection].some(bg =>
    [text, muted, accent, link].some(foreground => contrast(bg, foreground) < 4.5))) return null;
  return { ...draft, name: draft.name.trim(), colors: { ...draft.colors } };
}

export function normalizeCustomTheme(theme) {
  const { id, ...draft } = theme || {};
  if (typeof id !== "string" || !/^custom-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) return null;
  if (Array.isArray(draft.colors)) {
    if (draft.colors.length !== 6 || !Number.isInteger(draft.radius) || draft.radius < 0 || draft.radius > 24) return null;
    const [background, surface, accent, text, border, button] = draft.colors;
    const legacy = normalizeDraft({ ...themeDraft(), name: draft.name, density: draft.density,
      colors: { background, sidebar: surface, surface, text, muted: text, accent, button, border,
        link: accent, selection: background, input: background }, cardRadius: draft.radius, buttonRadius: draft.radius });
    return legacy && { id, ...legacy };
  }
  const normalized = normalizeDraft(draft);
  return normalized && { id, ...normalized };
}

export function exportTheme(theme) {
  const normalized = normalizeCustomTheme(theme);
  if (!normalized) return null;
  const { id, ...draft } = normalized;
  return JSON.stringify({ format: "rpm-theme", version: 1, theme: draft }, null, 2);
}

export function importTheme(json) {
  if (typeof json !== "string" || json.length > 16384) return null;
  try {
    const data = JSON.parse(json);
    if (!sameKeys(data, { format: "", version: 1, theme: {} }) || data.format !== "rpm-theme" || data.version !== 1) return null;
    return normalizeDraft(data.theme);
  } catch {
    return null;
  }
}

export function customPalette(theme) {
  const normalized = normalizeCustomTheme(theme);
  if (!normalized) return null;
  const { id, name, colors, cardRadius, buttonRadius, density, motion, shadows, text: textSize } = normalized;
  const { background, sidebar, surface, accent, text, muted, border, button, link, selection, input } = colors;
  const ink = color => contrast(color, "#ffffff") >= 4.5 ? "#ffffff" : "#000000";
  return { id, name, colors: [background, surface, selection, text, muted, accent, accent, border, input, ink(accent)],
    sidebar, link, selection, button, buttonText: ink(button), cardRadius, buttonRadius, density, motion, shadows, textSize,
    light: contrast(background, "#000000") > contrast(background, "#ffffff") };
}

export function validateAppearance(value) {
  if (!value) return null;
  const { preferences } = value;
  if (!preferences || !["compact", "comfortable"].includes(preferences.density)
      || !["system", "reduce", "none"].includes(preferences.motion)
      || !["system", "light", "dark"].includes(preferences.automatic)
      || !["small", "standard", "large"].includes(preferences.text)
      || typeof preferences.effects !== "boolean") return null;
  const { customThemes, favorites, focus, recentThemes, schedule, highContrast } = preferences;
  const normalized = Array.isArray(customThemes) ? customThemes.map(normalizeCustomTheme) : null;
  if (customThemes !== undefined && (!Array.isArray(customThemes) || customThemes.length > 12 ||
      !normalized.every(Boolean) || new Set(normalized.map(item => item.id)).size !== customThemes.length)) return null;
  if (schedule !== undefined && (!sameKeys(schedule, { light: "", dark: "" }) ||
      !Object.values(schedule).every(time => typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) ||
      schedule.light === schedule.dark)) return null;
  if (highContrast !== undefined && typeof highContrast !== "boolean") return null;
  const valid = id => isTheme(id) || customThemes?.some(item => item.id === id);
  if (!valid(value.theme) || (favorites !== undefined && (!Array.isArray(favorites) ||
      favorites.length > 66 || !favorites.every(valid))) || (focus !== undefined && typeof focus !== "boolean") ||
      (recentThemes !== undefined && (!Array.isArray(recentThemes) || recentThemes.length > 6 || !recentThemes.every(valid)))) return null;
  return { theme: value.theme, preferences: { density: preferences.density, motion: preferences.motion,
    automatic: preferences.automatic, text: preferences.text, effects: preferences.effects,
    ...(favorites !== undefined && { favorites: [...new Set(favorites)] }),
    ...(focus !== undefined && { focus }),
    ...(recentThemes !== undefined && { recentThemes: [...new Set(recentThemes)] }),
    ...(schedule !== undefined && { schedule }),
    ...(highContrast !== undefined && { highContrast }),
    ...(customThemes !== undefined && { customThemes: normalized })
  } };
}
