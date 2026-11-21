import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { structureDocument } from "../documents.js";

const [desktop, downloads] = process.argv.slice(2);
if (!desktop || !downloads) throw new Error("Укажите папки рабочего стола и загрузок.");

const file = new URL("../laws.json", import.meta.url);
const laws = JSON.parse(await readFile(file, "utf8"));
const addedAt = new Date().toISOString();
const sources = [
  ["epk", "ЕПК.txt", desktop, "law", null, "ЕДИНЫЙ ПРОЦЕССУАЛЬНЫЙ КОДЕКС ШТАТА RPM (ЕПК)"],
  ["oath-army", "Присяга армии.txt", desktop, "oath", "Армия"],
  ["advocacy-secrecy", "Адвокатскаяя Тайна.txt", desktop, "policy", "Адвокатура"],
  ["oath-hospital", "Клятва гипокерата.txt", desktop, "oath", "Больница"],
  ["charter-university", "Устав Универ.txt", downloads, "charter", "Университет"],
  ["charter-media", "Устав СМИ.txt", downloads, "charter", "СМИ"],
  ["charter-army", "Устав Армия.txt", downloads, "charter", "Армия"],
  ["charter-hospital", "Устав Больницы.txt", downloads, "charter", "Больница"],
  ["charter-cpd", "Устав ЦПД.txt", downloads, "charter", "CPD"]
];

for (const [id, source, dir, type, organization, title] of sources) {
  const bytes = await readFile(path.join(dir, source)).catch(error => {
    if (error.code !== "ENOENT") throw error;
    console.error(`Файл отсутствует: ${source}`);
  });
  if (!bytes) continue;
  const fullText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const structure = structureDocument(fullText, type);
  const previous = laws.documents.find(doc => doc.id === id);
  const revision = id === "epk" ? "2026-11-20" : null;
  if (revision) {
    assert.match(fullText, /Дата подписания:\s*\[20\.11\.2026\]/u);
    assert.match(fullText, /Губернатор:\s*Лиам Уэйн/u);
    assert.match(fullText, /Подпись губернатора:\s*trpd/u);
    const counts = ["chapter", "article", "point"].map(kind => structure.filter(entry => entry.kind === kind).length);
    assert.deepEqual(counts, [11, 51, 216]);
    assert.ok(structure.some(entry => entry.title === "Заключительные положения"));
    console.warn("ЕПК: 11 глав, 51 заголовок «Статья», 216 пунктов и отдельные ненумерованные заключительные положения.");
  }
  if (previous?.fullText === fullText) {
    previous.structure = structure;
    continue;
  }
  if (previous) {
    laws.archivedDocuments ??= [];
    const signed = previous.fullText?.match(/Дата подписания:\s*\[\s*(\d{2})\.(\d{2})\.(\d{4})/u);
    laws.archivedDocuments.push({ ...previous, revision: previous.revision || (signed ? `${signed[3]}-${signed[2]}-${signed[1]}` : null),
      documentId: id, id: `${id}-archive-${laws.archivedDocuments.length + 1}`, status: "archived", archivedAt: addedAt });
  }
  const sections = structure.filter(entry => entry.kind === "chapter").map(chapter => ({
    title: chapter.title,
    articles: structure.filter(entry => entry.kind === "article" && entry.chapter === chapter.number).map(entry => {
      const end = structure.find(next => next.line > entry.line && ["article", "chapter", "section"].includes(next.kind));
      return { number: entry.number, title: entry.title, text: fullText.split(/\r?\n/).slice(entry.line, end?.line).join("\n").trim() };
    })
  }));
  const document = { id, name: title || path.parse(source).name, type, organization, revision, status: "active", addedAt, source, fullText, structure, sections, articles: [] };
  const index = laws.documents.indexOf(previous);
  if (index < 0) laws.documents.push(document);
  else laws.documents[index] = document;
}

laws.documents = laws.documents.map(doc => ({ type: "law", organization: null, revision: null, status: "active", addedAt: laws.updatedAt || addedAt, ...doc }));
const oldEpk = laws.archivedDocuments?.find(doc => doc.documentId === "epk" && /Дата подписания:\s*\[\s*09\.10\.2026/u.test(doc.fullText || ""));
if (oldEpk) Object.assign(oldEpk, { revision: "2026-10-09", type: "law", organization: null, addedAt: oldEpk.addedAt || laws.updatedAt || null });
const tmp = new URL("../laws.json.import-tmp", import.meta.url);
await writeFile(tmp, JSON.stringify(laws, null, 2) + "\n");
await rename(tmp, file);
