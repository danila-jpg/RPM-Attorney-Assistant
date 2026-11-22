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
  palette("royal-blue", "Royal Navy", "#091225 #122341 #1a3157 #eff6ff #a8bddb #8bbcff #acd1ff #365785 #0e1a30 #101e38"),
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
  palette("eucalyptus", "Eucalyptus", "#eaf4ee #fbfffc #dcece2 #1d372b #456354 #23634b #174b37 #779b87 #fafffb #ffffff", true)
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

export function customPalette(theme) {
  const { id, name, colors, radius, density } = theme || {};
  if (!/^custom-[0-9a-f-]{36}$/.test(id || "") || typeof name !== "string" ||
      !name.trim() || name.length > 40 || !Array.isArray(colors) || colors.length !== 6 ||
      !colors.every(color => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) ||
      !Number.isInteger(radius) || radius < 0 || radius > 24 || !["compact", "comfortable"].includes(density)) return null;
  const [bg, surface, accent, text, border, button] = colors;
  if ([bg, surface].some(color => contrast(color, text) < 4.5 || contrast(color, accent) < 4.5)) return null;
  const buttonText = contrast(button, "#ffffff") >= 4.5 ? "#ffffff" : "#000000";
  return { id, name: name.trim(), colors: [bg, surface, bg, text, text, accent, accent, border, bg, buttonText],
    button, radius, density, light: contrast(bg, "#000000") > contrast(bg, "#ffffff") };
}

export function validateAppearance(value) {
  if (!value) return null;
  const { preferences } = value;
  if (!preferences || !["compact", "comfortable"].includes(preferences.density)
      || !["system", "reduce", "none"].includes(preferences.motion)
      || !["system", "light", "dark"].includes(preferences.automatic)
      || !["small", "standard", "large"].includes(preferences.text)
      || typeof preferences.effects !== "boolean") return null;
  const { customThemes, favorites, focus } = preferences;
  if (customThemes !== undefined && (!Array.isArray(customThemes) || customThemes.length > 12 ||
      !customThemes.every(customPalette) || new Set(customThemes.map(item => item.id)).size !== customThemes.length)) return null;
  const valid = id => isTheme(id) || customThemes?.some(item => item.id === id);
  if (!valid(value.theme) || (favorites !== undefined && (!Array.isArray(favorites) ||
      favorites.length > 50 || !favorites.every(valid))) || (focus !== undefined && typeof focus !== "boolean")) return null;
  return { theme: value.theme, preferences: { density: preferences.density, motion: preferences.motion,
    automatic: preferences.automatic, text: preferences.text, effects: preferences.effects,
    ...(favorites !== undefined && { favorites: [...new Set(favorites)] }),
    ...(focus !== undefined && { focus }),
    ...(customThemes !== undefined && { customThemes: customThemes.map(({ id, name, colors, radius, density }) =>
      ({ id, name: name.trim(), colors, radius, density })) })
  } };
}
