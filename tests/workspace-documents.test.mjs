import { normalizeDocumentText } from "../documents.js";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import { citation, resolveNorm, searchableEntries, structureDocument } from "../documents.js";
import { gradeQuestion, makeQuestions, summarizeTraining, validateQuestion } from "../training.js";

const { documents, archivedDocuments } = JSON.parse(await readFile(new URL("../laws.json", import.meta.url), "utf8"));
const epk = documents.find(doc => doc.id === "epk");
const oldEpk = archivedDocuments.find(doc => doc.documentId === "epk");
const cpd = documents.find(doc => doc.id === "charter-cpd");

test("EPK source structure and archived revision", () => {
  assert.equal(epk.revision, "2026-11-20");
  assert.equal(epk.status, "active");
  assert.equal(oldEpk.revision, "2026-10-09");
  assert.equal(oldEpk.status, "archived");
  assert.match(epk.fullText, /Заключительные положения[\s\S]+Подпись губернатора: trpd/u);
  assert.deepEqual(structureDocument(epk.fullText, "law"), epk.structure);
  assert.deepEqual(["chapter", "article", "point"].map(kind => epk.structure.filter(entry => entry.kind === kind).length), [11, 51, 216]);
});

test("resolves exact point, detects wrong chapter, ambiguity and missing point", () => {
  const result = resolveNorm(documents, "ЕПК, глава III, статья 3, пункт 3.4");
  assert.equal(result.status, "confirmed");
  const [norm] = result.matches;
  assert.match(norm.text, /^3\.4\./);
  assert.ok(epk.fullText.replaceAll("\r\n", "\n").includes(norm.text));
  assert.equal(resolveNorm(documents, norm.reference).matches[0].id, norm.id);
  assert.equal(resolveNorm(documents, "ЕПК, глава III, статья 2, пункт 3.4").status, "missing");
  assert.equal(resolveNorm(documents, "ЕПК, глава XVI, статья 3, пункт 3.4").status, "missing");
  assert.equal(resolveNorm(documents, "ЕПК, статья 3").status, "ambiguous");
  assert.equal(resolveNorm(documents, "ЕПК, глава III, статья 3, пункт 3.99").status, "missing");
  assert.equal(resolveNorm(documents, "ЕПК, глава III, статья 3, пункт неверный").status, "missing");
  assert.equal(resolveNorm(documents, "ЕПК, глава III, статья 3, пункт 3.4, редакция 2026-10-09").status, "missing");
  assert.equal(resolveNorm([...documents, oldEpk], "ЕПК, глава III, статья 3").matches[0].documentId, "epk");
});

test("imports every charter, oath and policy and resolves a CPD subpoint", () => {
  const charters = documents.filter(doc => ["charter", "oath", "policy"].includes(doc.type));
  assert.equal(charters.length, 8);
  assert.ok(charters.every(doc => doc.fullText && doc.organization && doc.source && doc.revision === null));
  assert.equal(cpd.structure.filter(entry => entry.kind === "chapter").length, 7);
  const result = resolveNorm(documents, "Устав CPD, глава I, пункт 1.5, подпункт 1.5.2");
  assert.equal(result.status, "confirmed");
  assert.match(result.matches[0].text, /15:30/);
  assert.equal(resolveNorm(documents, citation(cpd, result.matches[0])).status, "confirmed");
});

test("generates and grades sourced questions, excluding archived material", () => {
  for (const doc of [epk, cpd]) {
    const questions = makeQuestions([doc, oldEpk], "exam", 20);
    assert.equal(questions.length, 20);
    for (const question of questions) {
      assert.equal(question.documentId, doc.id);
      assert.ok(doc.fullText.replaceAll("\r\n", "\n").includes(question.text));
      assert.equal(new Set(question.choices).size, 4);
      assert.equal(gradeQuestion(question, "exam", question.correct), true);
      assert.equal(gradeQuestion(question, "exam", (question.correct + 1) % 4), false);
      assert.equal(gradeQuestion(question, "exam", 99), null);
    }
  }
  assert.deepEqual(makeQuestions([oldEpk], "quiz", 5), []);
  const practice = makeQuestions([cpd], "practice", 10);
  assert.equal(practice.length, 10);
  assert.match(practice[0].prompt, /удалил видеозапись/u);
  assert.match(practice[0].text, /72 часов/u);
  assert.match(practice[0].explanation, /срок хранения/u);
  const questions = makeQuestions([cpd], "quiz", 5);
  const at = "2026-11-21T00:00:00.000Z";
  const progress = summarizeTraining([{ mode: "quiz", questions, answers: { 0: { correct: true, at }, 1: { correct: false, at } }, completed_at: at }]);
  assert.equal(progress.tests, 1);
  assert.equal(progress.correct, 1);
  assert.equal(progress.incorrect, 1);
  assert.equal(progress.best, 20);
  assert.equal(progress.lastTraining, at);
});


test("ANSI normalization preserves Unicode, numbering, whitespace and literal HTML as text", () => {
  const source = [
    "```ansi",
    "\\x1b[2;35m1. Глава I. Присяга 🏛️\\x1b[0m",
    "",
    "\\u001b[31m2. Редакция и примечание\\033[0m",
    "\x1b]0;Terminal title\x07\x1b[2K3. <script>пример</script>",
    "```",
    "",
    "```text",
    "Обычный текст.",
    "```"
  ].join("\r\n");
  const expected = [
    "", "1. Глава I. Присяга 🏛️", "", "2. Редакция и примечание",
    "3. <script>пример</script>", "", "", "```text", "Обычный текст.", "```"
  ].join("\r\n");
  assert.equal(normalizeDocumentText(source), expected);
  assert.equal(normalizeDocumentText("  4. Буква ё\n\n  Примечание"), "  4. Буква ё\n\n  Примечание");
  assert.equal(normalizeDocumentText(""), "");
  assert.equal(normalizeDocumentText(null), "");
});

test("training audits at least 100 questions across laws and charters", () => {
  const corpus = [epk, cpd, ...documents.filter(doc => ["charter-media", "charter-army"].includes(doc.id))];
  const counts = [0, 0, 0, 0];
  const questions = makeQuestions(corpus, "exam", 140);
  assert.equal(questions.length, 140);
  assert.ok(new Set(questions.map(question => question.documentId)).size >= 3);
  for (const question of questions) {
    assert.ok(validateQuestion(question), question.reference);
    assert.ok(question.choiceSources.every(source => source.revision && source.anchor && source.source));
    assert.equal(gradeQuestion(question, "exam", question.correct), true);
    counts[question.correct]++;
  }
  assert.ok(counts.every(count => count >= 12 && count <= 58), JSON.stringify(counts));
});

test("media charter clause 4.2 has number-free choices tied to exact source passages", () => {
  const doc = documents.find(doc => doc.id === "charter-media");
  const question = makeQuestions([doc], "quiz", 100).find(item => item.anchor === "line-39");
  assert.equal(question?.type, "content");
  assert.match(question.prompt, /пункт 4\.2/u);
  assert.ok(question.choices.every(choice => !/\b\d+\.\d+\b/u.test(choice)));
  assert.match(question.choices[question.correct], /брать интервью.+собирать информацию/u);
  assert.equal(question.choiceSources[question.correct].anchor, "line-39");
  assert.ok(question.choiceSources.filter((_, index) => index !== question.correct).every(source => {
    const original = searchableEntries(doc).find(entry => entry.id === source.anchor);
    return original && !/брать интервью.+собирать информацию/u.test(original.text);
  }));
  const leaked = structuredClone(question);
  leaked.choices[leaked.correct] = "4.2 " + leaked.choices[leaked.correct];
  assert.equal(validateQuestion(leaked), false);
});

test("curated learning tasks use sourced statements and grade each selection", () => {
  const media = documents.find(doc => doc.id === "charter-media");
  const questions = makeQuestions([media, cpd], "quiz", 200);
  const multiple = questions.find(question => question.type === "multiple");
  const boolean = questions.find(question => question.type === "boolean");
  assert.ok(multiple && validateQuestion(multiple));
  assert.ok(boolean && validateQuestion(boolean));
  assert.equal(gradeQuestion(multiple, "quiz", multiple.correct.toReversed()), true);
  assert.equal(gradeQuestion(multiple, "quiz", multiple.correct.slice(0, 1)), false);
  assert.equal(gradeQuestion(multiple, "quiz", [0, 0]), null);
  assert.equal(gradeQuestion(boolean, "quiz", boolean.correct), true);
  assert.equal(gradeQuestion(boolean, "quiz", 1 - boolean.correct), false);
});
