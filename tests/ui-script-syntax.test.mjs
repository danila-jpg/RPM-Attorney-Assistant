import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync("public/index.html", "utf8");
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

let checked = 0;

for (const match of scripts) {
  const attributes = match[1] || "";
  const code = match[2] || "";

  if (/\bsrc\s*=/i.test(attributes) || !code.trim()) continue;

  new vm.Script(code, { filename: `public/index.html:inline-${checked + 1}` });
  checked++;
}

if (!checked) {
  throw new Error("В HTML не найдено встроенных JavaScript-скриптов.");
}

console.log(`PASS: ${checked} inline JavaScript scripts parsed successfully`);
