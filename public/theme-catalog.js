export const defaultTheme = "quantum-purple";
export const defaultPreferences = Object.freeze({
  density: "comfortable", motion: "system", automatic: "system", text: "standard", effects: true
});

const palette = (id, name, colors, light = false) => ({ id, name, colors: colors.split(" "), light });
// Background, surface, hover, text, muted text, accent, accent hover, border, input, button text.
export const themes = [
  palette("midnight-purple", "Midnight Purple", "#090711 #151121 #211832 #f1eafa #aa9cbd #a16df2 #c49aff #39294f #0e0b17 #140924"),
  palette("graphite", "Graphite", "#08090b #17191e #22252c #f1f2f4 #a0a5af #b6bdcc #d1d7e1 #343943 #101216 #101216"),
  palette("amoled-black", "AMOLED Black", "#000000 #0d0d0d #1c1c1c #ffffff #bdbdbd #dedede #ffffff #363636 #080808 #000000"),
  palette("obsidian", "Obsidian", "#090c11 #141922 #202936 #eef4fc #a5b3c7 #93aee0 #b8cef1 #344257 #0f141c #101827"),
  palette("royal-blue", "Royal Blue", "#091225 #122341 #1a3157 #eff6ff #a8bddb #8bbcff #acd1ff #365785 #0e1a30 #101e38"),
  palette("ocean", "Ocean", "#07151d #102731 #193942 #e9fbfc #a0c4ca #64dbd1 #93eee7 #2c5661 #0b1e27 #092325"),
  palette("emerald", "Emerald", "#081811 #10271d #19392b #edf9f2 #acc7b7 #76e6ac #a1f2c5 #305a45 #0c2017 #0e2419"),
  palette("forest", "Forest", "#101711 #1b291d #283a29 #f3f6e9 #b5c3a7 #bbdb85 #d4eba7 #44573d #151f16 #192410"),
  palette("crimson", "Crimson", "#1b0d14 #2b1621 #41202e #fff0f5 #d4a9b8 #ff9db5 #ffbfd0 #683c4c #220f19 #36101d"),
  palette("sakura", "Sakura", "#fff4f7 #fffafd #f7e0ea #35232f #704c61 #942a5c #792049 #bb859e #fffafd #ffffff", true),
  palette("cyberpunk", "Cyberpunk", "#100a1e #1b1230 #2a1b47 #faf1ff #c6aed9 #ec93ff #91f4ff #634487 #140e24 #200a2a"),
  palette("samurai", "Samurai", "#110e0e #211917 #362321 #fff1e6 #c8b1a4 #ffa390 #f5cf86 #63433b #181212 #301410"),
  palette("old-money", "Old Money", "#101a14 #1a2920 #293a2d #f5f1e3 #c4beaa #dec58d #f0d8a8 #535e46 #142118 #27200f"),
  palette("golden-noir", "Golden Noir", "#100d0a #201a14 #342919 #fff4e3 #cab79d #eac57b #ffdda0 #5a4830 #18130e #2b1a05"),
  palette("arctic-light", "Arctic Light", "#eef6fc #ffffff #dfeefa #142d45 #405f79 #195a92 #124674 #779ab6 #f7fbff #ffffff", true),
  palette("ivory", "Ivory", "#f8f1e4 #fffaf1 #efe1ca #38271b #6b5140 #82502b #633a1e #ad9174 #fffcf6 #ffffff", true),
  palette("minimal-light", "Minimal Light", "#f1f3f8 #ffffff #e8ebf3 #202638 #505e76 #5743b3 #44318d #8793aa #f8f9fc #ffffff", true),
  palette("cyber-blue", "Cyber Blue", "#061321 #102238 #18324d #e9f5ff #9db9d1 #73caff #a2deff #355c79 #091a2b #072136")
];

export function isTheme(value) {
  return value === defaultTheme || value === "auto" || themes.some(theme => theme.id === value);
}

export function validateAppearance(value) {
  if (!value || !isTheme(value.theme)) return null;
  const { preferences } = value;
  if (!preferences || !["compact", "comfortable"].includes(preferences.density)
      || !["system", "reduce"].includes(preferences.motion)
      || !["system", "light", "dark"].includes(preferences.automatic)
      || !["standard", "large"].includes(preferences.text)
      || typeof preferences.effects !== "boolean") return null;
  return { theme: value.theme, preferences: { density: preferences.density, motion: preferences.motion,
    automatic: preferences.automatic, text: preferences.text, effects: preferences.effects } };
}
