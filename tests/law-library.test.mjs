import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { lawArticles, resolveNorm, structureDocument } from "../documents.js";

const readJson = name => JSON.parse(readFileSync(new URL("../" + name, import.meta.url), "utf8"));
const { documents, archivedDocuments } = readJson("laws.json");
const laws = documents.filter(doc => doc.type === "law" && doc.status === "active");

// Verified inventory for the bundled corpus. Review each changed count against its source.
const expected = {
  constitution: 23, ak: 18, uk: 102, epk: 51, advocacy: 20, social: 23, labor: 30,
  warrants: 26, judicial: 95, supervision: 35, access_rules: 17, emergency_martial: 14,
  private_business: 31, state_secrets: 23
};

test("all active laws and their article counts match the verified inventory", () => {
  assert.equal(laws.length, Object.keys(expected).length);
  assert.deepEqual(Object.fromEntries(laws.map(doc => [doc.id, lawArticles(doc).length])), expected);
  for (const doc of laws) {
    if (!doc.fullText) continue;
    const sourceHeadings = structureDocument(doc.fullText, "law").filter(entry => entry.kind === "article");
    assert.equal(lawArticles(doc).length, sourceHeadings.length, doc.id);
  }
});

test("EPK preserves every active article with its clauses and keeps the older edition separate", () => {
  const current = laws.find(doc => doc.id === "epk");
  assert.equal(current.revision, "2026-11-20");
  const source = current.fullText.split(/\r?\n/u);
  const articles = lawArticles(current);
  assert.deepEqual([...new Set(articles.map(article => article.chapter))],
    ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"]);
  for (const article of articles) {
    const boundary = current.structure.find(entry => entry.line > article.line &&
      ["section", "chapter", "article"].includes(entry.kind));
    const expectedText = source.slice(article.line, boundary?.line ?? source.length).join("\n");
    assert.equal(article.text.replace(/\s+/gu, " ").trim(), expectedText.replace(/\s+/gu, " ").trim(), article.id);
  }
  const archive = archivedDocuments.find(doc => doc.id === "epk-archive-1");
  const original = readJson("federal_laws.json").documents.find(doc => doc.id === "eupk");
  assert.equal(archive.fullText, original.fullText);
  assert.equal(lawArticles(archive).length, 53);
  assert.equal(resolveNorm([...laws, archive], "ЕПК, глава III, статья 3, пункт 3.4").status, "confirmed");
  const historical = resolveNorm([...laws, archive], "ЕПК, глава III, статья 11, редакция 09.10.2026");
  assert.equal(historical.matches[0]?.documentId, archive.id);
});
