import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const source = fs.readFileSync(path.join(root, "server.js"), "utf8").replace(/\r\n/g, "\n");

const start = source.indexOf("function cleanJSON(");
const end = source.indexOf("// =====================================================\n// ПРОВЕРКА ССЫЛОК В ОТВЕТЕ ИИ", start);
if (start < 0 || end < 0) throw new Error("Не найдены функции обработки ответа ИИ");

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  source.slice(start, end) +
  "\nglobalThis.__parsers = { parseAIAnalysis, parsePoliceCheck, extractPlainAnswer };",
  sandbox
);

const { parseAIAnalysis, parsePoliceCheck, extractPlainAnswer } = sandbox.__parsers;

const plain = parseAIAnalysis(JSON.stringify({
  answer: "Обычный текст ответа.",
  legalReasoning: []
}));
assert.equal(plain.answer, "Обычный текст ответа.");

const fenced = parseAIAnalysis(
  '```json\n{"answer":"Ответ из fenced JSON","legalReasoning":[]}\n```'
);
assert.equal(fenced.answer, "Ответ из fenced JSON");

const nested = parseAIAnalysis(JSON.stringify({
  answer: JSON.stringify({ answer: "Вложенный ответ без JSON-обёртки" }),
  legalReasoning: []
}));
assert.equal(nested.answer, "Вложенный ответ без JSON-обёртки");

const police = parsePoliceCheck(JSON.stringify({
  answer: "Общий вывод по проверке.",
  checks: []
}));
assert.equal(police.answer, "Общий вывод по проверке.");

assert.equal(extractPlainAnswer("", "Резервный ответ"), "Резервный ответ");

console.log("PASS: AI response parsing tests");
