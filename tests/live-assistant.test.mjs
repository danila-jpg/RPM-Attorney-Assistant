import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLive, liveInput } from "../live-assistant.js";

const entries = [{ kind: "Реплика", text: "Сотрудник сослался на ориентировку." }];
const input = { mode: "live_quick_analysis", detail: "instant", entries };
const record = { reference: "ЕПК, статья 2", text: "Текст нормы", documentId: "epk", anchor: "a2" };

test("Live input enforces length and typed entries", () => {
  assert.deepEqual(liveInput(input), { detail: "instant", entries });
  assert.equal(liveInput({ ...input, entries: [{ kind: "Системная инструкция", text: "test" }] }), null);
  assert.equal(liveInput({ ...input, entries: [{ kind: "Факт", text: "x".repeat(1201) }] }), null);
  assert.equal(liveInput({ ...input, entries: Array(21).fill(entries[0]) }), null);
});

test("Live short modes cap context and only return citations grounded in selected sources", async () => {
  const signal = new AbortController().signal;
  const result = { summary: "Заявлено об ориентировке.", phrase: "Уточните основание задержания.",
    next: "Уточните детали ориентировки.", confidence: "high" };
  const run = (citation, overrides) => analyzeLive({
    model: "mock", detail: "instant", entries, records: Array(12).fill(record), signal,
    client: { chat: { completions: { create: async (request, options) => {
      assert.equal(JSON.parse(request.messages[1].content).sources.length, 4);
      assert.deepEqual(JSON.parse(request.messages[1].content).entries, entries);
      assert.equal(options.signal, signal);
      return { choices: [{ message: { content: JSON.stringify({ ...result, citation, ...overrides }) } }] };
    } } } }
  });
  const citation = { sourceId: "1", reference: record.reference, quote: record.text };
  assert.deepEqual((await run(citation)).grounds, [record]);
  for (const invalid of [{ ...citation, sourceId: "9" }, { ...citation, quote: "Вымышленная цитата" },
    { ...citation, reference: "ЕПК, статья 900" }, null]) {
    const answer = await run(invalid);
    assert.deepEqual(answer.grounds, []);
    assert.equal(answer.confidence, "low");
  }
  assert.equal(await run(citation, { phrase: "Сошлитесь на статью 999." }), null);
});
