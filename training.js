import { randomInt } from "node:crypto";
import { citation, searchableEntries } from "./documents.js";

const scenarios = [
  { documentId: "epk", chapter: "III", article: "3", point: "3.4", quote: "Объявить причину задержания",
    prompt: "В вымышленном RP-деле сотрудник задержал гражданина, не назвав причину задержания и не зачитав Миранду. Какой пункт устанавливает обе обязанности в порядке задержания?",
    explanation: "В выбранном пункте перечислены оба действия. Для оценки эпизода потребуются запись задержания или иные доказательства того, что сотрудник сообщил гражданину." },
  { documentId: "charter-cpd", chapter: "II", article: "", point: "2.5", quote: "хранением в течение 72 часов",
    prompt: "В вымышленном RP-деле офицер CPD удалил видеозапись процессуального действия через сутки. Какой пункт устава следует проверить в первую очередь?",
    explanation: "В этом пункте установлены фиксация процессуальных действий и срок хранения записи. Для оценки эпизода важны время записи и подтверждение её удаления." }
];

function shuffle(items) {
  const output = [...items];
  for (let index = output.length - 1; index > 0; index--) {
    const position = randomInt(index + 1);
    [output[index], output[position]] = [output[position], output[index]];
  }
  return output;
}

export function makeQuestions(documents, mode, size) {
  const available = documents.filter(doc => doc.status !== "archived").flatMap(doc => {
    const entries = searchableEntries(doc);
    const points = entries.filter(entry => ["point", "subpoint", "article"].includes(entry.kind));
    const source = points.length ? points : entries;
    const legacy = (doc.articles || []).filter(article => typeof article.text === "string" && article.text.trim())
      .map(article => ({ kind: "article", article: String(article.number), text: article.text, title: article.title }));
    return (source.length ? source : legacy).map(entry => ({
      documentId: doc.id, document: doc.name, reference: citation(doc, entry),
      anchor: entry.id, text: entry.text, title: entry.title,
      scenario: scenarios.find(item => item.documentId === doc.id && item.chapter === entry.chapter &&
        item.article === entry.article && item.point === entry.point && entry.kind === "point" && entry.text.includes(item.quote))
    }));
  }).filter(entry => entry.text?.trim());
  const unique = [...new Map(available.map(entry => [entry.reference, entry])).values()];
  const selected = shuffle(unique);
  if (mode === "practice") selected.sort((a, b) => Number(Boolean(b.scenario)) - Number(Boolean(a.scenario)));
  return selected.slice(0, size).map(({ scenario, ...entry }) => {
    const practice = mode === "practice";
    const choices = mode === "cards" ? [] : shuffle([
      practice ? entry.reference : entry.text,
      ...shuffle([...new Set(unique.filter(other => other.reference !== entry.reference && other.text !== entry.text)
        .map(other => practice ? other.reference : other.text))]).slice(0, 3)
    ]);
    return {
      ...entry, choices,
      prompt: practice
        ? scenario?.prompt || `В учебном RP-деле помощник получил следующий фрагмент без ссылки. Какую норму нужно указать в материалах дела?\n\n${entry.text}`
        : entry.reference,
      explanation: scenario?.explanation || "Сопоставьте формулировку с точным текстом и реквизитами источника.",
      correct: choices.indexOf(practice ? entry.reference : entry.text)
    };
  });
}

export function gradeQuestion(question, mode, answer) {
  if (mode === "cards" && ["known", "repeat"].includes(answer)) return answer === "known";
  if (mode !== "cards" && Number.isInteger(answer) && answer >= 0 && answer < question.choices.length) {
    return question.correct === answer;
  }
  return null;
}

export function summarizeTraining(attempts) {
  const topics = {};
  let tests = 0, correct = 0, incorrect = 0, best = null;
  for (const attempt of attempts) {
    const scored = ["quiz", "exam", "practice"].includes(attempt.mode);
    const answers = Object.entries(attempt.answers);
    const hits = answers.filter(([, answer]) => answer.correct).length;
    if (scored) {
      correct += hits;
      incorrect += answers.length - hits;
      if (attempt.completed_at) {
        if (attempt.mode !== "practice") tests++;
        best = Math.max(best ?? 0, Math.round(hits * 100 / attempt.questions.length));
      }
    }
    for (const [index, answer] of answers) {
      const topic = attempt.questions[index].reference;
      topics[topic] ??= { correct: 0, incorrect: 0 };
      topics[topic][answer.correct ? "correct" : "incorrect"]++;
    }
  }
  const dates = attempts.flatMap(attempt => Object.values(attempt.answers).map(answer => answer.at).filter(Boolean));
  return { tests, correct, incorrect, best, topics, lastTraining: dates.sort().at(-1) ?? null };
}
