const heading = /^\s*(Глава|Раздел|Статья)\s+([IVXLCDM]+|\d+(?:\.\d+)*)\s*[.:—–-]?\s*(.*)$/iu;
const clause = /^\s*(\d+(?:\.\d+)+)[.)]?\s+(\S.*)$/u;
const note = /^\s*Примечание(?:\s+(\d+))?\s*[.:—–-]/iu;

export function structureDocument(fullText, type) {
  const entries = [];
  let chapter = "", section = "", article = "", point = "";
  const lines = fullText.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const marker = type === "law" ? line : line.normalize("NFKC").replace(/^\s*(?:>\s*)?(?:#{1,6}\s*)?(?:[-*]\s*)?`?\s*/u, "");
    const h = marker.match(heading) || (type !== "law" && marker.match(/^(лава|Ч\.)\s*(\d+)\s*(.*)$/u));
    const c = marker.match(clause) || (type !== "law" && marker.match(/^\s*(\d+)[.)]\s+(\S.*)$/u));
    const n = marker.match(note);
    let kind, number;
    if (h) {
      number = h[2].toUpperCase();
      kind = { глава: "chapter", лава: "chapter", раздел: "section", "ч.": "section", статья: "article" }[h[1].toLowerCase()];
      if (kind === "chapter") { chapter = number; section = ""; }
      if (kind === "section") { section = number; }
      if (kind !== "article") article = "";
      else article = number;
      point = "";
    } else if (c) {
      number = c[1];
      kind = point && number.startsWith(point + ".") ? "subpoint" : "point";
      if (kind === "point") point = number;
    } else if (n) {
      kind = "note";
      number = n[1] || "";
    } else if (/^Заключительные положения\s*$/iu.test(line) || /^Доп\.\s*Глава`?\s*$/iu.test(marker)) {
      kind = /^Доп\./iu.test(marker) ? "chapter" : "section";
      chapter = section = article = point = "";
      number = "";
    } else continue;
    entries.push({ id: `line-${index + 1}`, line: index, kind, number, chapter, section, article, point, title: line.trim() });
  }
  return entries.map((entry, index) => ({
    ...entry,
    text: lines.slice(entry.line, entries[index + 1]?.line ?? lines.length).join("\n").trim()
  }));
}

export function documentEntries(doc) {
  if (doc.structure) {
    const lines = documentDisplayText(doc).split(/\r\n|\n|\r/u);
    return doc.structure.map((entry, index) => ({
      ...entry,
      title: lines[entry.line]?.trim() || normalizeDocumentText(entry.title),
      text: lines.slice(entry.line, doc.structure[index + 1]?.line ?? lines.length).join("\n").trim()
    }));
  }
  if (doc.fullText) {
    const parsed = structureDocument(documentDisplayText(doc), doc.type || "law");
    if (parsed.length) return parsed;
  }
  const entries = [];
  const add = (articles, section = "") => {
    for (const article of articles || []) {
      const number = String(article.number ?? "");
      if (!number || typeof article.text !== "string" || !article.text.trim()) continue;
      const chapter = String(article.chapter || "").match(/^глава\s+(\w+)/iu)?.[1]?.toUpperCase() || "";
      entries.push({ kind: "article", article: number, number, section, chapter, title: normalizeDocumentText(article.title), text: normalizeDocumentText(article.text) });
    }
  };
  for (const section of doc.sections || []) add(section.articles, String(section.number || section.title?.match(/^раздел\s+(\d+)/iu)?.[1] || ""));
  const topLevel = (doc.articles || []).filter(article => !entries.some(entry => entry.number === String(article.number)));
  add(topLevel);
  if (doc.fullText) return entries;
  let line = 0;
  return entries.map(entry => {
    const anchor = { id: `line-${line + 1}`, line };
    line += formattedArticle(entry).split(/\r\n|\n|\r/u).length + 1;
    return { ...entry, ...anchor };
  });
}

function formattedArticle(entry) {
  return [entry.title || entry.number, entry.text].join("\n");
}

export function searchableEntries(doc) {
  const entries = documentEntries(doc);
  if (!entries.length && doc.fullText) {
    return [{ id: "line-1", line: 0, kind: "document", number: "", title: doc.name, text: documentDisplayText(doc) }];
  }
  return entries;
}

export function lawArticles(doc, entries = doc.structure ? searchableEntries(doc) : null) {
  if (!entries) return Array.isArray(doc.articles) ? doc.articles : [];
  const articles = [];
  let current, chapterTitle, sectionTitle;
  for (const entry of entries) {
    if (entry.kind === "chapter") {
      chapterTitle = entry.title;
      sectionTitle = null;
    }
    if (entry.kind === "section") sectionTitle = entry.title;
    if (entry.kind === "article") {
      current = { ...entry, chapterTitle, sectionTitle };
      articles.push(current);
    } else if (entry.kind === "chapter" || entry.kind === "section") {
      current = null;
    } else if (current && entry.text) {
      current.text += "\n" + entry.text;
    }
  }
  return articles;
}

export function citation(doc, entry) {
  const parts = [doc.name];
  if (entry.chapter) parts.push(`глава ${entry.chapter}`);
  if (entry.section) parts.push(`раздел ${entry.section}`);
  if (entry.article) parts.push(`статья ${entry.article}`);
  if (entry.point) parts.push(`пункт ${entry.point}`);
  if (entry.kind === "subpoint") parts.push(`подпункт ${entry.number}`);
  if (entry.kind === "note") parts.push(`примечание ${entry.number}`.trim());
  if (doc.revision) parts.push(`редакция ${doc.revision}`);
  return parts.join(", ");
}

export function resolveNorm(documents, query) {
  const aliases = { epk: ["епк", "единый процессуальный кодекс"], uk: ["ук"], ak: ["ак"], "charter-cpd": ["устав cpd", "устав цпд"] };
  const normalized = String(query).normalize("NFKC").toLowerCase().replaceAll("ё", "е");
  const prefix = normalized.split(/,|\s+(?:глава|раздел|статья|пункт|подпункт|примечание|редакция)\s/u)[0].trim();
  const fields = {};
  for (const [label, key] of Object.entries({ глава: "chapter", раздел: "section", статья: "article", пункт: "point", подпункт: "subpoint", примечание: "note", редакция: "revision" })) {
    const marker = new RegExp(`(?:^|[\\s,])${label}(?=\\s|,|$)`, "gu");
    const occurrences = [...normalized.matchAll(marker)];
    if (!occurrences.length) continue;
    const raw = normalized.slice(occurrences[0].index + occurrences[0][0].length).match(/^\s+([a-z0-9][a-z0-9.-]*)(?=\s|,|$)/u)?.[1];
    if (occurrences.length > 1 || (!raw && key !== "note")) return { status: "missing", matches: [] };
    fields[key] = (raw || "").replace(/\.$/, "").toUpperCase();
  }
  if (fields.revision && /^\d{2}\.\d{2}\.\d{4}$/.test(fields.revision)) {
    fields.revision = fields.revision.split(".").reverse().join("-");
  }
  const docMatches = documents.filter(doc => [doc.id, doc.documentId, ...(aliases[doc.documentId || doc.id] || []), doc.name].some(name => name?.toLowerCase().replaceAll("ё", "е") === prefix)
    && (fields.revision ? doc.revision === fields.revision : doc.status !== "archived" || doc.id === prefix));
  const kind = ["note", "subpoint", "point", "article", "section", "chapter"].find(key => Object.hasOwn(fields, key));
  const matches = docMatches.flatMap(doc => documentEntries(doc)
    .filter(entry => entry.kind === kind && Object.entries(fields).every(([key, value]) =>
      key === "revision" || (key === "note" || key === "subpoint" ? entry.number : entry[key]) === value))
    .map(entry => ({ ...entry, documentId: doc.id, document: doc.name, reference: citation(doc, entry) })));
  return { status: matches.length === 1 ? "confirmed" : matches.length ? "ambiguous" : "missing", matches };
}
import { stripVTControlCharacters } from "node:util";

const literalEscape = /\\(?:x1b|u001b|u\{1b\}|033)(?=[\[\]PX^_()#%NO78=>])/giu;
const controlStrings = /(?:\x1b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[^\r\n]*?(?:\x07|\x1b\\|\u009c)/gu;

export function normalizeDocumentText(value) {
  const original = String(value ?? "");
  let fence;
  let ansiFence = false;
  return original.split(/(\r\n|\n|\r)/u).map((line, index) => {
    if (index % 2) return line;
    const decoded = line.replace(literalEscape, "\x1b")
      .replace(/\\(?:x07|u0007)(?=[^\r\n]*$)/giu, (match, offset, text) =>
        /\x1b\]/u.test(text.slice(0, offset)) ? "\x07" : match);
    const clean = stripVTControlCharacters(decoded.replace(controlStrings, ""))
      .replace(/\x1b(?:[()][0-2A-Z]|[78=>])/gu, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, "");
    const marker = clean.match(/^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/iu);
    if (!marker) return clean;
    if (!fence) {
      fence = marker[1];
      ansiFence = marker[2].toLowerCase() === "ansi";
      return ansiFence ? "" : clean;
    }
    if (!marker[2] && marker[1][0] === fence[0] && marker[1].length >= fence.length) {
      const remove = ansiFence;
      fence = undefined;
      ansiFence = false;
      return remove ? "" : clean;
    }
    return clean;
  }).join("");
}

export function documentDisplayText(doc) {
  if (doc.fullText) return normalizeDocumentText(doc.fullText);
  return documentEntries(doc).map(formattedArticle).join("\n\n");
}

