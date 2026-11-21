import test from "node:test";
import assert from "node:assert/strict";
import { themes, defaultPreferences, defaultTheme, isTheme, validateAppearance } from "../public/theme-catalog.js";

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
