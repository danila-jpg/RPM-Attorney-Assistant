import { createHash, randomInt } from "node:crypto";
import { citation, normalizeDocumentText, searchableEntries } from "./documents.js";

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

const numbering = /^\s*(?:(?:Статья|Пункт|Подпункт)\s+)?\d+(?:[.-]\d+)*(?:[.)])?\s+/iu;
const references = /(?:\b\d+(?:\.\d+){1,}\b|(?:стать[а-я]+|(?:под)?пункт[а-я]*)\s+№?\s*\d)/iu;
const markup = /[\u0000-\u001f\u007f-\u009f]|<\/?[a-z][^>]*>|\*\*|\x60|\\u001b|\[\d+(?:;\d+)*m/iu;
const identity = value => value.toLowerCase().replaceAll("?", "?").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function optionText(entry) {
  const text = normalizeDocumentText(entry.text).split("\n")[0].trim().replace(/^>\s*/, "").replace(/\*/g, "");
  if (text.includes("\n") || !numbering.test(text)) return "";
  return text.replace(numbering, "").replace(/^[-—–]\s*/, "").replace(/\s+/g, " ").replace(/[.!?;:]+$/, "") + ".";
}

export function validateQuestion(question) {
  const { choices, choiceSources, correct, type, source, revision, anchor, explanation, prompt } = question;
  if (![source, revision, anchor, explanation, prompt].every(value => typeof value === "string" && value.trim())) return false;
  if ([...choices, ...prompt.split("\n"), ...explanation.split("\n")].some(value => markup.test(value))) return false;
  if (type === "cards") return choices.length === 0;
  if (type === "boolean") {
    return choices.length === 2 && choices.includes("Верно") && choices.includes("Неверно") &&
      choices[correct] === (question.statementTrue ? "Верно" : "Неверно");
  }
  if (type === "multiple") {
    if (choices.length !== 4 || new Set(choices.map(identity)).size !== choices.length || !Array.isArray(correct) || correct.length !== 2 ||
        !choiceSources || choiceSources.length !== choices.length) return false;
    const matches = choiceSources.flatMap((item, index) => item.documentId === question.documentId && item.anchor === anchor ? [index] : []);
    return matches.length === correct.length && matches.every((index, position) => index === correct[position]) &&
      choices.every(choice => !references.test(choice) && !identity(prompt).includes(identity(choice)));
  }
  if (choices.length !== 4 || new Set(choices.map(identity)).size !== 4 || !Number.isInteger(correct) || !choices[correct]) return false;
  if (choiceSources?.length !== choices.length || choiceSources.some(item => !item.documentId || !item.anchor || !item.source || !item.revision)) return false;
  const matches = choiceSources.filter(item => item.documentId === question.documentId && item.anchor === anchor);
  if (matches.length !== 1 || choiceSources[correct] !== matches[0]) return false;
  if (type === "lookup" || type === "scenario") {
    return choices.every(choice => !prompt.toLowerCase().includes(choice.toLowerCase()) && /^[\p{L} ]+\s[\d.]+$/u.test(choice));
  }
  const lengths = choices.map(choice => choice.length);
  return Math.max(...lengths) <= Math.min(...lengths) * 2.3 &&
    choices.every(choice => choice.length >= 22 && !references.test(choice) && !identity(prompt).includes(identity(choice))) &&
    choices.every(choice => /^(\p{Lu}|\d)/u.test(choice) === /^(\p{Lu}|\d)/u.test(choices[0]));
}

export function makeQuestions(documents, mode, size) {
  const groups = documents.filter(doc => doc.status !== "archived" && (doc.source || doc.articles?.length || doc.sections?.length)).map(doc => {
    const revision = doc.revision || 'снимок ' + createHash('sha256')
      .update(doc.fullText || JSON.stringify([doc.articles, doc.sections])).digest('hex').slice(0, 12);
    return searchableEntries(doc).filter(entry => entry.id && entry.text?.trim() &&
      ["point", "article"].includes(entry.kind)).map(entry => ({
      documentId: doc.id, document: doc.name, reference: citation(doc, entry), anchor: entry.id,
      source: doc.source || "laws.json · " + doc.id, revision, text: entry.text, kind: entry.kind, number: entry.point || entry.article,
      label: entry.kind === "point" ? "Пункт " + entry.point : "Статья " + entry.article,
      body: optionText(entry),
      scenario: scenarios.find(item => item.documentId === doc.id && item.chapter === entry.chapter &&
        item.article === entry.article && item.point === entry.point && entry.kind === "point" && entry.text.includes(item.quote))
    }));
  });
  const questions = groups.flatMap(entries => entries.flatMap(entry => {
    const { scenario, body, label, kind, number, ...target } = entry;
    const base = { ...target, explanation: "Источник — " + target.reference + ". Сверьте формулировку с цитатой из указанной редакции." };
    if (mode === "cards") {
      const question = { ...base, type: "cards", prompt: target.reference, choices: [] };
      return validateQuestion(question) ? [question] : [];
    }
    const peers = entries.filter(other => other !== entry && other.kind === kind &&
      other.number !== number && other.body && identity(other.body) !== identity(body));
    const make = (type, prompt, candidates, display) => {
      const alternatives = [...new Map(shuffle(candidates).map(item => [identity(display(item)), item])).values()].slice(0, 3);
      const ordered = shuffle([entry, ...alternatives]);
      return { ...base, type, prompt, choices: ordered.map(display), correct: ordered.indexOf(entry),
        choiceSources: ordered.map(({ documentId, anchor, source, revision, reference }) =>
          ({ documentId, anchor, source, revision, reference })) };
    };
    const result = [];
    if (mode === "quiz" && scenario?.documentId === "charter-cpd") {
      const quotes = [
        { shown: "72 часа", source: "72 часов", correct: true },
        { shown: "24 часа", source: "24 часов", correct: false }
      ];
      const statement = quotes[randomInt(quotes.length)];
      if (entry.text.includes(quotes[0].source) && !entry.text.includes(quotes[1].source)) {
        const choices = shuffle(["Верно", "Неверно"]);
        const question = { ...base, type: "boolean", choices, statementTrue: statement.correct,
          correct: choices.indexOf(statement.correct ? "Верно" : "Неверно"),
          prompt: "Верно ли, что по указанной норме видеозаписи процессуальных действий хранятся " + statement.shown + "?\n" + target.reference,
          explanation: "В пункте установлен срок хранения видеозаписей 72 часа." };
        if (validateQuestion(question)) return [question];
      }
    }
    if (mode === "quiz" && entry.documentId === "charter-media" && number === "2.8") {
      const excerpts = [
        ["2.8", "поддерживать должный уровень работоспособности"],
        ["2.8", "не допускать пребывания в сонливом состоянии на рабочем месте"],
        ["2.4", "информировать любыми способами весь город о новейших событиях"],
        ["2.13", "предоставить сведения о своём местоположении и деятельности"]
      ];
      const sourced = excerpts.map(([number, text]) => ({ text, norm: entries.find(item => item.number === number && item.text.includes(text)) }));
      if (sourced.every(item => item.norm) && sourced.filter(item => item.norm === entry).length === 2) {
        const ordered = shuffle(sourced);
        const question = { ...base, type: "multiple",
          prompt: "Выберите все требования, перечисленные в этом пункте.\n" + target.reference,
          choices: ordered.map(item => item.text),
          choiceSources: ordered.map(({ norm: { documentId, anchor, source, revision, reference } }) =>
            ({ documentId, anchor, source, revision, reference })),
          correct: ordered.flatMap((item, index) => item.norm === entry ? [index] : []) };
        if (validateQuestion(question)) return [question];
      }
    }
    if (body && !references.test(body) && entries.filter(other => identity(other.body) === identity(body)).length === 1) {
      const prompt = "Какой фрагмент приведён в указанной норме?\n" + target.reference;
      const sourceWords = (target.document.match(/\b[A-Z]{2,}\b|[А-ЯЁ]{2,}/g) || []).map(identity);
      const hasWord = (value, word) => identity(value).split(" ").includes(word);
      const peersWithoutHints = peers.filter(other => !references.test(other.body) &&
        other.body.length >= body.length / 1.6 && other.body.length <= body.length * 1.6 &&
        !identity(body).includes(identity(other.body)) && !identity(other.body).includes(identity(body)) &&
        sourceWords.every(word => hasWord(other.body, word) === hasWord(body, word)));
      const text = make("content", prompt, peersWithoutHints, item => item.body);
      if (validateQuestion(text)) result.push(text);
      if (mode === "practice" || result.length === 0 || randomInt(3) === 0) {
        if (entries.filter(other => other.label === label).length !== 1) return result;
        const lookup = make(scenario ? "scenario" : "lookup",
          scenario ? target.document + "\n" + scenario.prompt :
            "В какой норме документа «" + target.document + "» приведён этот фрагмент?\n\n" + body,
          peers, item => item.label);
        if (scenario) lookup.explanation = scenario.explanation;
        if (validateQuestion(lookup)) result.push(lookup);
      }
    }
    return result;
  }));
  const ordered = shuffle(questions);
  ordered.sort((a, b) => {
    const priority = question => question.type === "scenario" && mode === "practice" ? 2 : question.type === "content" ? 1 : 0;
    return priority(b) - priority(a);
  });
  const seen = new Set();
  return ordered.filter(question => {
    if (seen.has(question.reference)) return false;
    seen.add(question.reference);
    return true;
  }).slice(0, size);
}

export function gradeQuestion(question, mode, answer) {
  if (mode === "cards" && ["known", "repeat"].includes(answer)) return answer === "known";
  if (question.type === "multiple") {
    if (!Array.isArray(answer) || !answer.length || answer.length > question.choices.length ||
        new Set(answer).size !== answer.length || answer.some(index => !Number.isInteger(index) || !question.choices[index])) return null;
    return answer.length === question.correct.length && answer.every(index => question.correct.includes(index));
  }
  if (mode !== "cards" && Number.isInteger(answer) && answer >= 0 && answer < question.choices.length) {
    return question.correct === answer;
  }
  return null;
}

export function summarizeTraining(attempts) {
  const topics = {};
  const documents = {};
  const history = [];
  let tests = 0, correct = 0, incorrect = 0, best = null;
  for (const attempt of attempts) {
    if (attempt.mode === "exam" && !attempt.completed_at) continue;
    const scored = ["quiz", "exam", "practice"].includes(attempt.mode);
    const answers = Object.entries(attempt.answers);
    const hits = answers.filter(([, answer]) => answer.correct).length;
    if (scored) {
      correct += hits;
      incorrect += answers.length - hits;
      if (attempt.completed_at) {
        if (attempt.mode !== "practice") tests++;
        const percent = Math.round(hits * 100 / attempt.questions.length);
        best = Math.max(best ?? 0, percent);
        if (attempt.id && history.length < 30) history.push({ id: attempt.id, mode: attempt.mode, percent, at: attempt.completed_at });
      }
    }
    for (const [index, answer] of answers) {
      const { reference: topic, documentId, document } = attempt.questions[index];
      documents[documentId] ??= { name: document, correct: 0, incorrect: 0 };
      documents[documentId][answer.correct ? "correct" : "incorrect"]++;
      topics[topic] ??= { correct: 0, incorrect: 0 };
      topics[topic][answer.correct ? "correct" : "incorrect"]++;
    }
  }
  const dates = attempts.filter(attempt => attempt.mode !== "exam" || attempt.completed_at).flatMap(attempt => Object.values(attempt.answers).map(answer => answer.at).filter(Boolean));
  return { tests, correct, incorrect, best, topics, documents, history, lastTraining: dates.sort().at(-1) ?? null };
}
