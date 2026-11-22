import { createHash } from "node:crypto";
import { documentDisplayText, searchableEntries } from "./documents.js";

export function revisionInfo(doc) {
  return {
    id: doc.id, documentId: doc.documentId || doc.id, name: doc.name,
    revision: doc.revision || null, effectiveFrom: doc.effectiveFrom || null,
    status: doc.status || "active", source: doc.source || null,
    checksum: createHash("sha256").update(doc.fullText || documentDisplayText(doc)).digest("hex")
  };
}

export function compareRevisions(before, after) {
  const readable = doc => searchableEntries(doc).filter(entry => entry.kind !== "document");
  const reference = entry => [entry.kind, entry.section, entry.chapter, entry.number].join("/");
  const wording = entry => {
    const number = String(entry.number || "");
    const text = /^\d+(?:\.\d+)*$/.test(number)
      ? entry.text.replace(new RegExp("^(?:(?:статья|пункт)\\s+)?" + number.replaceAll(".", "\\.") + "[.)]?\\s+", "iu"), "")
      : entry.text;
    return text.trim().replace(/\s+/g, " ");
  };
  const old = readable(before);
  const current = readable(after);
  const remaining = new Set(current);
  const matches = new Map();
  for (const sameReference of [true, false]) {
    for (const entry of old) {
      if (matches.has(entry)) continue;
      const match = current.find(next => remaining.has(next) && wording(next) === wording(entry)
        && (!sameReference || reference(next) === reference(entry)));
      if (match) { matches.set(entry, match); remaining.delete(match); }
    }
  }
  return [
    ...old.map(entry => {
      const exact = matches.get(entry);
      if (exact) return { status: "unchanged", moved: reference(entry) !== reference(exact), before: entry, after: exact };
      const changed = current.find(next => remaining.has(next) && reference(next) === reference(entry));
      if (changed) remaining.delete(changed);
      return { status: changed ? "changed" : "removed", before: entry, after: changed || null };
    }),
    ...[...remaining].map(entry => ({ status: "added", before: null, after: entry }))
  ];
}

export function selectRevision(documents, archive, revisionId) {
  if (revisionId === undefined) return documents;
  const selected = [...documents, ...archive].find(item => item.id === revisionId && item.status !== "draft");
  if (!selected) return null;
  if (documents.includes(selected)) return documents;
  // A historical analysis is scoped to the known historical source.
  return [selected];
}
