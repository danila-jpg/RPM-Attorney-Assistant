
import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LAWS_FILE = path.join(__dirname, "laws.json");
const CASES_FILE = path.join(__dirname, "cases.json");

const APP_USER = process.env.APP_USER;
const APP_PASSWORD = process.env.APP_PASSWORD;
const MODEL = process.env.OPENAI_MODEL || "gemini-3.1-flash-lite";

const client = process.env.GEMINI_API_KEY
    ? new OpenAI({
      apiKey: process.env.GEMINI_API_KEY,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
    })
    : null;

// =====================================================
// АВТОРИЗАЦИЯ
// =====================================================

function safeCompare(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  return first.length === second.length &&
      timingSafeEqual(first, second);
}

function requireAuth(req, res, next) {
  if (!APP_USER || !APP_PASSWORD) {
    console.error("Authentication is not configured!");
    return res.status(503).send("Server authentication is not configured.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme !== "Basic" || !encoded) {
    res.setHeader(
        "WWW-Authenticate",
        'Basic realm="RPM Attorney Assistant", charset="UTF-8"'
    );
    return res.status(401).send("Authentication required.");
  }

  let credentials;

  try {
    credentials = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return res.status(401).send("Invalid credentials.");
  }

  const separator = credentials.indexOf(":");

  if (separator < 0) {
    return res.status(401).send("Invalid credentials.");
  }

  const username = credentials.slice(0, separator);
  const password = credentials.slice(separator + 1);

  if (
      !safeCompare(username, APP_USER) ||
      !safeCompare(password, APP_PASSWORD)
  ) {
    return res.status(401).send("Invalid username or password.");
  }

  next();
}

app.use(requireAuth);
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// =====================================================
// JSON
// =====================================================

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

// =====================================================
// ЗАКОНЫ
// =====================================================

app.get("/api/laws", async (req, res) => {
  try {
    res.json(await readJson(LAWS_FILE, { documents: [] }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/laws", async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ error: "Некорректный формат законов." });
    }

    await writeJson(LAWS_FILE, req.body);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// ПРОВЕРКА СЕРВЕРА
// =====================================================

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    aiConfigured: Boolean(client),
    provider: "Google Gemini",
    model: MODEL
  });
});

// =====================================================
// ИСТОРИЯ ДЕЛ
// =====================================================

app.get("/api/cases", async (req, res) => {
  res.json(await readJson(CASES_FILE, []));
});

app.post("/api/cases", async (req, res) => {
  try {
    const cases = await readJson(CASES_FILE, []);

    const item = {
      id: req.body.id || Date.now().toString(),
      title: req.body.title || "Новое дело",
      data: req.body.data || {},
      updatedAt: new Date().toISOString()
    };

    const index = cases.findIndex(c => c.id === item.id);

    if (index >= 0) {
      cases[index] = item;
    } else {
      cases.unshift(item);
    }

    await writeJson(CASES_FILE, cases);
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/cases/:id", async (req, res) => {
  try {
    const cases = await readJson(CASES_FILE, []);
    await writeJson(
        CASES_FILE,
        cases.filter(c => c.id !== req.params.id)
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================================================
// ПОИСК СТАТЕЙ
// =====================================================

function normalize(value) {
  return String(value || "")
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^а-яa-z0-9.\s-]/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
}

function getWords(value) {
  return [...new Set(
      normalize(value).split(/\s+/).filter(word => word.length >= 3)
  )];
}

function extractArticles(documents) {
  const result = [];

  function walk(node, documentName, depth = 0) {
    if (!node || typeof node !== "object" || depth > 12) return;

    if (Array.isArray(node)) {
      node.forEach(item => walk(item, documentName, depth + 1));
      return;
    }

    const currentName =
        node.documentName ||
        node.lawName ||
        node.name ||
        node.title ||
        documentName ||
        "Неизвестный документ";

    const title = String(
        node.article ||
        node.number ||
        node.title ||
        ""
    );

    const text = [
      node.text,
      node.content,
      node.fullText
    ].find(value =>
        typeof value === "string" && value.trim()
    ) || "";

    if (text.trim()) {
      result.push({
        document: documentName || currentName,
        title: title || "Текст документа",
        text: text.trim()
      });
    }

    const childKeys = [
      "articles",
      "sections",
      "chapters",
      "items"
    ];

    for (const key of childKeys) {
      if (node[key] && typeof node[key] === "object") {
        walk(node[key], currentName, depth + 1);
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (
          !childKeys.includes(key) &&
          value &&
          typeof value === "object"
      ) {
        walk(value, currentName, depth + 1);
      }
    }
  }

  for (const doc of documents) {
    walk(doc, doc.name || doc.title || "Неизвестный документ");
  }

  const unique = new Map();

  for (const article of result) {
    const key = normalize(
        article.document + article.title + article.text
    );

    if (!unique.has(key)) unique.set(key, article);
  }

  return [...unique.values()];
}

function findRelevantArticles(documents, searchText) {
  const articles = extractArticles(documents);
  const words = getWords(searchText);

  if (!words.length) return [];

  const numbers = [
    ...new Set(
        String(searchText).match(/\b\d+(?:\.\d+)+\b/g) || []
    )
  ];

  const exact = articles.filter(article => {
    const title = normalize(article.title);

    return numbers.some(number => {
      const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`).test(title);
    });
  });

  const exactKeys = new Set(
      exact.map(a => normalize(a.document + a.title + a.text))
  );

  const ranked = articles
      .filter(a => !exactKeys.has(normalize(a.document + a.title + a.text)))
      .map(article => {
        const title = normalize(article.title);
        const document = normalize(article.document);
        const text = normalize(article.text);

        let score = 0;

        for (const word of words) {
          if (title.includes(word)) score += 5;
          if (document.includes(word)) score += 3;
          if (text.includes(word)) score += 1;
        }

        return { ...article, score };
      })
      .filter(a => a.score > 0)
      .sort((a, b) => b.score - a.score);

  return [...exact, ...ranked];
}

function prepareLawsForAI(articles) {
  const MAX_ARTICLES = 18;
  const MAX_ARTICLE_LENGTH = 7000;
  const MAX_TOTAL_LENGTH = 45000;

  const selected = [];
  let total = 0;

  for (const article of articles) {
    if (selected.length >= MAX_ARTICLES) break;

    const formatted = [
      `Документ: ${article.document}`,
      `Статья: ${article.title}`,
      `Полный текст статьи и примечаний: ${article.text.slice(0, MAX_ARTICLE_LENGTH)}`
    ].join("\n");

    if (total + formatted.length > MAX_TOTAL_LENGTH) continue;

    selected.push(formatted);
    total += formatted.length;
  }

  return selected.length
      ? selected.join("\n\n--------------------\n\n")
      : "Подходящие статьи с текстом не найдены.";
}

// =====================================================
// ИНСТРУКЦИИ ИИ
// =====================================================

function createInstructions({ mode, caseData, officerAnswer, lawsForAI }) {
  const analysisFormat = `
ОСОБОЕ ТРЕБОВАНИЕ ДЛЯ РЕЖИМА ANALYZE:

Верни результат строго в формате JSON без Markdown и без
текстовых пояснений до или после JSON.

Структура:

{
  "answer": "Полный текст анализа дела на русском языке",
  "legalReasoning": [
    {
      "article": "Точное название статьи и документа",
      "whyApplied": "Почему эта статья может применяться",
      "establishedElements": ["Подтверждённый признак"],
      "evidence": ["Конкретное подтверждающее доказательство"],
      "missingEvidence": ["Каких сведений не хватает"],
      "defenseArguments": ["Аргумент защиты"],
      "exceptions": ["Примечания и исключения из текста закона"],
      "conclusion": "Подтверждено"
    }
  ]
}

Допустимые значения conclusion:
- "Подтверждено"
- "Вероятно"
- "Недостаточно данных"
- "Не применимо"

ПРАВИЛА ДЛЯ legalReasoning:

1. Включай только статьи, текст которых действительно присутствует
   в предоставленной базе законов.
2. Не создавай номера статей самостоятельно.
3. Если статья не подходит к обстоятельствам, укажи
   "Не применимо" и объясни причину.
4. Не называй факт подтверждённым, если он основан только
   на предположении или словах одной стороны.
5. В evidence включай только реально предоставленные материалы.
6. Если доказательств нет, оставь массив пустым.
7. В missingEvidence указывай конкретные недостающие сведения.
8. Обязательно проверяй примечания и специальные исключения.
9. Если исключение применимо, объясни его значение.
10. Не смешивай незаконность задержания с незаконностью обыска.
11. Если статья не найдена, не выдумывай её ради заполнения карточки.
12. Если подходящих статей нет, верни пустой массив legalReasoning.
13. Не делай вывод о виновности человека только по факту обвинения.
14. Не представляй аргументы защиты как доказанные факты.
15. В answer обязательно объясни ограничения анализа.
`;

  return `
Ты — RPM Attorney Assistant, помощник адвоката
в ролевом проекте RPM.

Твоя задача — анализировать игровые правовые ситуации
исключительно на основании переданных нормативных документов RPM.

ОБЩИЕ ПРАВИЛА:

1. Используй только предоставленные законы RPM и материалы дела.
2. Не используй реальные законы РФ, Латвии, США или других стран.
3. Не придумывай статьи, части, пункты, сроки, полномочия и санкции.
4. Не приписывай статье содержание, которого нет в её тексте.
5. Разделяй подтверждённые факты, предположения и заявления участников.
6. Не объявляй человека виновным до достаточного подтверждения.
7. Не считай отсутствие ответа сотрудника доказательством нарушения.
8. Не гарантируй освобождение или удовлетворение ходатайства.
9. Если нужной нормы нет, прямо сообщи об этом.
10. Проверяй статью полностью, включая примечания и исключения.

ПРОВЕРКА ЗАКОНОВ:

- Проверяй специальные нормы и исключения.
- Не игнорируй примечания к статьям.
- Не смешивай незаконность задержания и незаконность обыска.
- Не считай любое процессуальное нарушение автоматическим
  основанием для исключения всех доказательств.
- Если нормы кажутся противоречивыми, объясни это.
- Не утверждай, что доказательство недопустимо, не проверив
  способ его получения и применимые исключения.
- Если информации недостаточно, укажи, что нужно установить.

ПРАВИЛА ЗАДЕРЖАНИЯ:

Различай:
А) сотрудник не смог назвать статью;
Б) статья отсутствует в материалах;
В) законного основания задержания не существовало.

Это разные обстоятельства.

Одного незнания статьи сотрудником недостаточно,
чтобы автоматически признать задержание незаконным.

Не утверждай, что сотрудник обязан объявить статью
непосредственно в момент задержания, если такая норма
не содержится в переданных документах.

ПРАВИЛА ДОКАЗАТЕЛЬСТВ:

Для каждого доказательства оцени:
- Что именно оно подтверждает.
- Кто его предоставил.
- При каких обстоятельствах оно получено.
- Есть ли сведения о его подлинности и полноте.
- Соблюдались ли процессуальные требования.
- Есть ли применимое исключение.
- Какие сомнения остаются.

РЕЖИМ: ${mode}

МАТЕРИАЛЫ ДЕЛА:
${JSON.stringify(caseData, null, 2)}

ОТВЕТ СОТРУДНИКА:
${officerAnswer || "Не предоставлен"}

НАЙДЕННЫЕ ЗАКОНЫ RPM:
${lawsForAI}

ТРЕБОВАНИЯ К РЕЖИМАМ:

${mode === "analyze" ? analysisFormat : ""}

Если режим evaluate_answer:
Проведи предметную проверку ответа сотрудника.
Используй структуру:
1. Оценка ответа.
2. Что установлено.
3. Чего не хватает.
4. Правовое значение.
5. Следующий вопрос.
6. Рекомендация адвокату.

Если режим followup:
Предложи следующие вопросы и действия с учётом материалов дела.
Каждый вопрос должен помогать получить конкретную информацию.

Если режим questions:
Составь сложные, но корректные вопросы сотруднику.
Объясни, что помогает выяснить каждый вопрос.

Если режим reference:
Подготовь практическую памятку адвокату на основании законов RPM.

ОТВЕЧАЙ НА РУССКОМ ЯЗЫКЕ.
Не выдумывай нормы.
`;
}

// =====================================================
// ПАРСИНГ СТРУКТУРИРОВАННОГО ОТВЕТА
// =====================================================

function parseAIAnalysis(raw) {
  const text = String(raw || "").trim();

  const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

  try {
    const parsed = JSON.parse(cleaned);

    return {
      answer: String(parsed.answer || "Анализ не получен."),
      legalReasoning: Array.isArray(parsed.legalReasoning)
          ? parsed.legalReasoning.map(item => ({
            article: String(item.article || "Статья не указана"),
            whyApplied: String(item.whyApplied || ""),
            establishedElements: Array.isArray(item.establishedElements)
                ? item.establishedElements.map(String) : [],
            evidence: Array.isArray(item.evidence)
                ? item.evidence.map(String) : [],
            missingEvidence: Array.isArray(item.missingEvidence)
                ? item.missingEvidence.map(String) : [],
            defenseArguments: Array.isArray(item.defenseArguments)
                ? item.defenseArguments.map(String) : [],
            exceptions: Array.isArray(item.exceptions)
                ? item.exceptions.map(String) : [],
            conclusion: [
              "Подтверждено",
              "Вероятно",
              "Недостаточно данных",
              "Не применимо"
            ].includes(item.conclusion)
                ? item.conclusion
                : "Недостаточно данных"
          }))
          : []
    };
  } catch {
    return {
      answer: text || "ИИ не вернул ответ.",
      legalReasoning: []
    };
  }
}

// =====================================================
// ГЛАВНЫЙ ИИ-ОБРАБОТЧИК
// =====================================================

app.post("/api/attorney-assist", async (req, res) => {
  try {
    if (!client) {
      return res.status(503).json({
        error: "Gemini API не настроен. Проверь GEMINI_API_KEY."
      });
    }

    const {
      mode = "analyze",
      caseData = {},
      laws = {},
      officerAnswer = ""
    } = req.body || {};

    const allowedModes = [
      "analyze",
      "evaluate_answer",
      "followup",
      "questions",
      "reference"
    ];

    if (!allowedModes.includes(mode)) {
      return res.status(400).json({
        error: "Неизвестный режим анализа."
      });
    }

    const documents = Array.isArray(laws)
        ? laws
        : Array.isArray(laws?.documents)
            ? laws.documents
            : [];

    let searchText = [
      caseData?.suspectedArticle,
      caseData?.article,
      caseData?.title,
      caseData?.description,
      caseData?.evidence,
      caseData?.accusation,
      caseData?.facts,
      caseData?.notes,
      officerAnswer
    ].filter(Boolean).join(" ");

    if (mode === "reference") {
      searchText = [
        caseData?.description,
        caseData?.title,
        caseData?.notes
      ].filter(Boolean).join(" ");
    }

    const relevantArticles = findRelevantArticles(documents, searchText);
    const lawsForAI = prepareLawsForAI(relevantArticles);

    console.log("AI request:", {
      mode,
      documents: documents.length,
      totalArticles: extractArticles(documents).length,
      selectedArticles: Math.min(relevantArticles.length, 18)
    });

    const instructions = createInstructions({
      mode,
      caseData,
      officerAnswer,
      lawsForAI
    });

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: "Подготовь ответ по указанному режиму." }
      ],
      temperature: 0.2
    });

    const rawAnswer =
        completion.choices?.[0]?.message?.content || "ИИ не вернул ответ.";

    if (mode === "analyze") {
      const parsed = parseAIAnalysis(rawAnswer);
      return res.json(parsed);
    }

    res.json({ answer: rawAnswer });

  } catch (error) {
    console.error("AI error:", error);

    res.status(error.status === 429 ? 429 : 500).json({
      error: "Ошибка обращения к Gemini API: " + error.message
    });
  }
});

// =====================================================
// ЗАПУСК
// =====================================================

app.listen(PORT, () => {
  console.log("RPM Attorney Assistant запущен:");
  console.log(`http://localhost:${PORT}`);
  console.log("Модель:", MODEL);
});
