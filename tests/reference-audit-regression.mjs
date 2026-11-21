import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const source = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8").replace(/\r\n/g, "\n");
const laws = JSON.parse(fs.readFileSync(path.join(projectRoot, "laws.json"), "utf8"));

const start = source.indexOf("function normalize(");
const end = source.indexOf("// =====================================================\n// ОБЩИЕ ИНСТРУКЦИИ ИИ", start);

if (start < 0 || end < 0) {
  throw new Error("Не удалось найти функции аудита в server.js");
}

const sandbox = {
  app: { get() {}, post() {} },
  console,
  Set,
  Map,
  WeakSet
};

vm.createContext(sandbox);
vm.runInContext(
  source.slice(start, end) +
  "\nglobalThis.__auditTest = { extractArticles, auditReferences, calculateAuditSummary };",
  sandbox
);

const { extractArticles, auditReferences, calculateAuditSummary } = sandbox.__auditTest;
// Keep the original article-only audit assertions against their original revision.
const archived = laws.archivedDocuments.find(doc => doc.documentId === "epk");
assert.ok(archived);
const all = extractArticles(laws.documents.map(doc => doc.id === "epk" ? { ...archived, id: "epk" } : doc));

function auditOne(reference) {
  const result = auditReferences([reference], all);
  assert.equal(result.length, 1, `Ожидалась одна запись: ${reference}`);
  return result[0];
}

const epk = auditOne("ЕПК, Глава III, Статья 4");
assert.equal(epk.status, "Подтверждено");
assert.equal(epk.matches[0].document, "Единый Процессуальный Кодекс");

const wrongDoc = auditOne("Уголовный кодекс, Глава III, Статья 4");
assert.equal(wrongDoc.status, "Документ не совпадает");
assert.equal(wrongDoc.matches.length, 0);
assert.ok(wrongDoc.otherDocumentMatches.length > 0);
assert.ok(wrongDoc.otherDocumentMatches.every(x => x.document !== "Уголовный кодекс"));

const numberOnly = auditOne("Статья 4");
assert.equal(numberOnly.status, "Недостаточно данных для подтверждения");

const articleWithPoint = auditOne("ЕПК, Глава III, Статья 4, пункт 2");
assert.equal(articleWithPoint.status, "Подтверждено");
assert.equal(articleWithPoint.number, "4");

const pointOnly = auditOne("ЕПК, пункт 2");
assert.equal(pointOnly.status, "Не указан номер статьи");

const ukArticle = auditOne("УК, статья 3.1");
assert.equal(ukArticle.status, "Подтверждено");
assert.equal(ukArticle.matches[0].sectionNumber, "3");

const ukSection = auditOne("УК, Раздел 3, Статья 3.1");
assert.equal(ukSection.status, "Подтверждено");

const wrongChapter = auditOne("УК, Глава III, Статья 3.1");
assert.equal(wrongChapter.status, "Глава не совпадает");

const epkWrongChapter = auditOne("ЕПК, Глава IV, Статья 4");
assert.equal(epkWrongChapter.status, "Глава не совпадает");

const summary = calculateAuditSummary([
  epk, wrongDoc, numberOnly, articleWithPoint, pointOnly,
  ukArticle, ukSection, wrongChapter, epkWrongChapter
]);
assert.equal(summary.confirmed, 4);
assert.equal(summary.unconfirmed, 5);
assert.equal(summary.total, 9);

console.log("PASS: strict reference-audit regression tests");
console.log(JSON.stringify({
  extractedArticles: all.length,
  epkChapterIIIArticle4: epk.status,
  wrongDocument: wrongDoc.status,
  numberOnly: numberOnly.status,
  ukSection3Article3_1: ukSection.status,
  wrongChapter: wrongChapter.status,
  summary
}, null, 2));
