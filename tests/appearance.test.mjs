import test from "node:test";
import assert from "node:assert/strict";
import { themes, defaultPreferences, defaultTheme, isTheme, validateAppearance, themeDraft,
  normalizeCustomTheme, customPalette, contrast, importTheme, exportTheme } from "../public/theme-catalog.js";

function luminance(color) {
  return color.match(/[0-9a-f]{2}/g).reduce((sum, value, index) => {
    const srgb = parseInt(value, 16) / 255;
    const linear = srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

test("all theme palettes have at least 4.5:1 contrast for text, links and primary controls", () => {
  assert.ok(themes.length >= 16);
  assert.equal(new Set(themes.map(theme => theme.id)).size, themes.length);
  for (const { id, colors } of themes) {
    const [bg, surface, hover, text, muted, accent, accentHover, , input, accentText] = colors;
    for (const [foreground, background] of [
      [text, bg], [text, input], [muted, surface], [muted, hover],
      [accent, surface], [accent, hover], [accentText, accent], [accentText, accentHover]
    ]) {
      const a = luminance(foreground), b = luminance(background);
      const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      assert.ok(contrast >= 4.5, `${id}: ${foreground} on ${background}: ${contrast}`);
    }
  }
});

test("appearance validation keeps legacy keys and rejects unsupported settings", () => {
  for (const theme of [defaultTheme, "minimal-light", "graphite", "cyber-blue", "auto"]) {
    assert.ok(isTheme(theme));
    const appearance = { theme, preferences: { ...defaultPreferences } };
    assert.deepEqual(validateAppearance(appearance), appearance);
    assert.equal(validateAppearance({ ...appearance, preferences: { ...appearance.preferences, effects: "false" } }), null);
  }
  assert.equal(validateAppearance({ theme: "missing", preferences: defaultPreferences }), null);
});

test("catalog contains all requested themes once and preserves legacy theme identifiers", () => {
  const requested = "Tokyo Night|Imperial|Nord|Dracula|Matrix|Sunset|Lavender Dream|Solarized Dark|Royal Navy|Rose Gold|Cherry Blossom|Deep Space|Neon City|Moonlight|White Marble|Coffee House|Dark Academia|Vintage Paper|Titanium|Frost Glass|Aurora Borealis|Blood Moon|Jade Dynasty|Desert Sand|Sakura Midnight|Electric Violet|Hacker Terminal|Polar Night|Champagne|Amethyst".split("|");
  for (const name of requested) assert.equal(themes.filter(theme => theme.name === name).length, 1, name);
  for (const legacy of "auto quantum-purple midnight-purple graphite amoled-black obsidian royal-blue ocean emerald forest crimson sakura cyberpunk samurai old-money golden-noir arctic-light ivory minimal-light cyber-blue sakura-night tokyo-night imperial solarized-dark nord dracula matrix sunset lavender copper glacier plum clay olive ink linen mulberry stone citrus eucalyptus".split(" ")) {
    assert.ok(isTheme(legacy), legacy);
  }
  assert.equal(new Set(themes.map(theme => theme.colors.join(" "))).size, themes.length);
});

test("presets convert to editable themes, legacy themes migrate, and JSON imports are validated", () => {
  const id = "custom-5038b941-5dd7-4daa-850f-73ab8553c159";
  for (const theme of themes) assert.ok(normalizeCustomTheme({ id, ...themeDraft(theme) }), theme.name);
  const legacy = { id, name: "Старая тема", colors: ["#08090b", "#17191e", "#b6bdcc", "#f1f2f4", "#343943", "#b6bdcc"],
    radius: 14, density: "compact" };
  const normalized = normalizeCustomTheme(legacy);
  assert.equal(normalized.cardRadius, 14);
  assert.equal(normalized.buttonRadius, 14);
  const { id: _, ...draft } = normalized;
  const exported = exportTheme(legacy);
  assert.deepEqual(importTheme(exported), draft);
  const data = JSON.parse(exported);
  const contrastingButton = customPalette({ id, ...draft, colors: { ...draft.colors, button: "#000000" } });
  assert.ok(contrast(contrastingButton.button, contrastingButton.buttonText) >= 4.5);
  assert.ok(contrast(contrastingButton.colors[5], contrastingButton.colors[9]) >= 4.5);
  assert.equal(importTheme(JSON.stringify({ ...data, html: "<script>" })), null);
  assert.equal(importTheme(JSON.stringify({ ...data, theme: { ...draft, motion: "url(javascript:alert(1))" } })), null);
  assert.equal(importTheme(JSON.stringify({ ...data, theme: { ...draft, colors: { ...draft.colors, link: "#08090b" } } })), null);
  assert.equal(importTheme(exported.slice(0, -1)), null);
  assert.equal(importTheme(" ".repeat(16000) + exported.repeat(4)), null);
});
