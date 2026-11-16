
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

  return (
      first.length === second.length &&
      timingSafeEqual(first, second)
  );
}

function requireAuth(req, res, next) {
  if (!APP_USER || !APP_PASSWORD) {
    console.error("Authentication is not configured!");
    return res.status(503).send(
        "Server authentication is not configured."
    );
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
    return res.status(401).send(
        "Invalid username or password."
    );
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
    return JSON.parse(
        await fs.readFile(file, "utf8")
    );
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.writeFile(
      file,
      JSON.stringify(data, null, 2),
      "utf8"
  );
}

const BACKUP_DIR = path.join(__dirname, "backups");
const MAX_CASE_BACKUPS = 30;

async function backupCases(){
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });

    let currentData;

    try {
      currentData = await fs.readFile(CASES_FILE, "utf8");
    } catch(error) {
      if(error.code === "ENOENT") {
        currentData = "[]";
      } else {
        throw error;
      }
    }

    const cases = JSON.parse(currentData);

    const files = await fs.readdir(BACKUP_DIR);

    // Удаляем пустые резервные копии
    for(const name of files.filter(name => /^cases-.*\.json$/.test(name))) {
      const filePath = path.join(BACKUP_DIR, name);

      try {
        const content = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(content);

        if(!Array.isArray(parsed) || parsed.length === 0) {
          await fs.unlink(filePath);
        }
      } catch(error) {
        console.error("Backup cleanup error:", name, error.message);
      }
    }

    // Не создаём копию, если дел нет
    if(!Array.isArray(cases) || cases.length === 0) {
      console.log("Backup skipped: no cases.");
      return;
    }

    const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-");

    const backupPath = path.join(
        BACKUP_DIR,
        `cases-${timestamp}.json`
    );

    await fs.writeFile(backupPath, JSON.stringify(cases, null, 2), "utf8");

    const updatedFiles = await fs.readdir(BACKUP_DIR);

    const backups = updatedFiles
        .filter(name => /^cases-.*\.json$/.test(name))
        .sort()
        .reverse();

    for(const oldBackup of backups.slice(MAX_CASE_BACKUPS)) {
      await fs.unlink(path.join(BACKUP_DIR, oldBackup));
    }

    console.log("Cases backup created:", backupPath);

  } catch(error) {
    console.error("Cases backup error:", error);
    throw error;
  }
}


// =====================================================
// ПОЛУЧЕНИЕ ЗАКОНОВ
// =====================================================

function getDocuments(laws) {
  if (Array.isArray(laws)) return laws;

  if (Array.isArray(laws?.documents)) {
    return laws.documents;
  }

  return [];
}

async function loadLaws() {
  return await readJson(LAWS_FILE, {
    documents: []
  });
}

// =====================================================
// API ЗАКОНОВ
// =====================================================

app.get("/api/laws", async (req, res) => {
  try {
    res.json(await loadLaws());
  } catch (error) {
    console.error("Load laws error:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

app.put("/api/laws", async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({
        error: "Некорректный формат законов."
      });
    }

    await writeJson(LAWS_FILE, req.body);

    res.json({
      success: true
    });
  } catch (error) {
    console.error("Save laws error:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

// =====================================================
// НОРМАЛИЗАЦИЯ
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
  return [
    ...new Set(
        normalize(value)
            .split(/\s+/)
            .filter(word => word.length >= 3)
    )
  ];
}

// =====================================================
// ИЗВЛЕЧЕНИЕ НОРМАТИВНЫХ ПОЛОЖЕНИЙ
// =====================================================

function extractArticles(documents) {
  const result = [];

  const collectionKeys = [
    "articles",
    "sections",
    "chapters",
    "items",
    "paragraphs",
    "parts",
    "notes",
    "appendices"
  ];

  function getText(value) {
    if (value == null) return "";

    if (
        typeof value === "string" ||
        typeof value === "number"
    ) {
      return String(value).trim();
    }

    if (Array.isArray(value)) {
      return value
          .map(getText)
          .filter(Boolean)
          .join("\n");
    }

    if (typeof value === "object") {
      return Object.entries(value)
          .map(([key, item]) => {
            const text = getText(item);
            return text ? `${key}: ${text}` : "";
          })
          .filter(Boolean)
          .join("\n");
    }

    return "";
  }

  function isChapterTitle(value) {
    return /^(глава|раздел|часть)\b|^[IVXLCDM]+\s*[.)-]/i.test(
        String(value || "").trim()
    );
  }

  function walk(
      node,
      document,
      context = {},
      seen = new WeakSet()
  ) {
    if (!node || typeof node !== "object") return;

    if (seen.has(node)) return;

    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, document, context, seen);
      }

      return;
    }

    const ownTitle = String(
        node.title || node.name || ""
    ).trim();

    const rawNumber =
        node.articleNumber ??
        node.number ??
        node.article ??
        "";

    const number = typeof rawNumber === "object"
        ? ""
        : String(rawNumber).trim();

    const isArticle = Boolean(
        number &&
        (
            node.text != null ||
            node.content != null ||
            node.description != null ||
            node.fullText != null ||
            node.penalty != null ||
            node.notes != null ||
            node.note != null ||
            ownTitle
        )
    );

    const nextContext = {
      ...context
    };

    if (node.chapter || node.chapterName) {
      nextContext.chapter = getText(
          node.chapterName || node.chapter
      );
    }

    if (node.section || node.sectionName) {
      nextContext.section = getText(
          node.sectionName || node.section
      );
    }

    if (!isArticle && ownTitle) {
      const hasChildren = collectionKeys.some(key =>
          node[key] && typeof node[key] === "object"
      );

      if (hasChildren) {
        if (
            node.chapterNumber ||
            isChapterTitle(ownTitle)
        ) {
          nextContext.chapter = ownTitle;
        } else if (!nextContext.section) {
          nextContext.section = ownTitle;
        }
      }
    }

    if (isArticle) {
      const penalty = getText(node.penalty);

      const exceptions = getText(
          node.exception || node.exceptions
      );

      const notes = getText(node.notes);
      const note = getText(node.note);
      const conditions = getText(node.conditions);
      const status = getText(node.status);

      const textParts = [
        getText(node.text),
        getText(node.content),
        getText(node.description),
        getText(node.fullText),

        penalty
            ? `Санкция: ${penalty}`
            : "",

        notes
            ? `Примечания: ${notes}`
            : "",

        note
            ? `Примечание: ${note}`
            : "",

        exceptions
            ? `Исключения: ${exceptions}`
            : "",

        conditions
            ? `Условия: ${conditions}`
            : "",

        status
            ? `Статус: ${status}`
            : ""
      ].filter(Boolean);

      let chapter = nextContext.chapter || "";
      let section = nextContext.section || "";

      // Некоторые документы хранят название главы
      // непосредственно в поле section.
      if (!chapter && isChapterTitle(section)) {
        chapter = section;
        section = "";
      }

      const article = {
        documentId: String(document.id || ""),
        document: String(
            document.name || "Документ без названия"
        ),
        category: String(document.category || ""),
        chapter,
        section,
        number,
        title: ownTitle || "Без названия",
        text: [...new Set(textParts)].join("\n"),
        source: String(
            node.source || document.source || ""
        ),
        status,
        penalty,
        exceptions
      };

      article.reference = [
        article.document,
        article.chapter,
        article.section,
        `статья ${article.number}`
      ].filter(Boolean).join(", ");

      result.push(article);
    }

    for (const key of collectionKeys) {
      if (
          node[key] &&
          typeof node[key] === "object"
      ) {
        walk(
            node[key],
            document,
            nextContext,
            seen
        );
      }
    }
  }

  for (const document of documents || []) {
    if (!document || typeof document !== "object") {
      continue;
    }

    const beforeCount = result.length;
    const seen = new WeakSet();

    // Сначала извлекаем структуру с главами.
    walk(
        document.sections || [],
        document,
        {},
        seen
    );

    // Затем общий список статей.
    walk(
        document.articles || [],
        document,
        {},
        seen
    );

    // Резерв для документов без структуры статей.
    if (
        result.length === beforeCount &&
        typeof document.fullText === "string" &&
        document.fullText.trim()
    ) {
      result.push({
        documentId: String(document.id || ""),
        document: String(
            document.name || "Документ без названия"
        ),
        category: String(document.category || ""),
        chapter: "",
        section: "",
        number: "Полный текст",
        title: "Полный текст документа",
        text: document.fullText,
        source: String(document.source || ""),
        status: "",
        penalty: "",
        exceptions: "",
        reference: `${
            document.name || "Документ"
        }, полный текст`
      });
    }
  }

  // ===================================================
  // УДАЛЕНИЕ ДУБЛИКАТОВ
  // ===================================================

  const unique = new Map();

  for (const article of result) {
    const key = [
      article.documentId,
      article.number,
      normalize(article.title),
      normalize(article.text)
    ].join("|");

    const existing = unique.get(key);

    if (!existing) {
      unique.set(key, article);
      continue;
    }

    const existingContext =
        Number(Boolean(existing.chapter)) +
        Number(Boolean(existing.section));

    const newContext =
        Number(Boolean(article.chapter)) +
        Number(Boolean(article.section));

    if (newContext > existingContext) {
      unique.set(key, {
        ...existing,
        ...article,

        penalty: article.penalty || existing.penalty,
        exceptions: article.exceptions || existing.exceptions,
        status: article.status || existing.status,
        source: article.source || existing.source
      });
    } else {
      existing.penalty ||= article.penalty;
      existing.exceptions ||= article.exceptions;
      existing.status ||= article.status;
      existing.source ||= article.source;
    }
  }

  const finalArticles = [
    ...unique.values()
  ];

  // Пересоздаём юридические ссылки.
  for (const article of finalArticles) {
    article.reference = [
      article.document,
      article.chapter,
      article.section,
      `статья ${article.number}`
    ].filter(Boolean).join(", ");
  }

  return finalArticles;
}

// =====================================================
// ПОИСК РЕЛЕВАНТНЫХ НОРМ
// =====================================================

function findRelevantArticles(
    articles,
    searchText,
    options = {}
) {
  const query = normalize(searchText || "");

  const words = getWords(searchText || "");

  const limit = Number(options.limit) > 0
      ? Math.min(Number(options.limit), 100)
      : 40;

  if (!query) return [];

  const requestedNumbers = [];

  const numberRegex =
      /(?:статья|статьи|ст\.|пункт|пункта|п\.)\s*№?\s*(\d+(?:\.\d+)*)/gi;

  let match;

  while (
      (match = numberRegex.exec(searchText || "")) !== null
      ) {
    requestedNumbers.push(match[1]);
  }

  const ranked = articles.map(article => {
    const title = normalize(article.title);
    const document = normalize(article.document);
    const chapter = normalize(article.chapter);
    const section = normalize(article.section);
    const text = normalize(article.text);
    const penalty = normalize(article.penalty);
    const exceptions = normalize(article.exceptions);

    let score = 0;

    // Совпадение целой поисковой фразы.
    if (title.includes(query)) {
      score += 45;
    }

    if (text.includes(query)) {
      score += 18;
    }

    if (chapter.includes(query)) {
      score += 8;
    }

    if (section.includes(query)) {
      score += 5;
    }

    // Совпадения отдельных слов.
    for (const word of words) {
      if (title.includes(word)) {
        score += 12;
      }

      if (text.includes(word)) {
        score += 4;
      }

      if (chapter.includes(word)) {
        score += 3;
      }

      if (section.includes(word)) {
        score += 2;
      }

      if (penalty.includes(word)) {
        score += 3;
      }

      if (exceptions.includes(word)) {
        score += 3;
      }

      if (document.includes(word)) {
        score += 1;
      }
    }

    // Точный номер статьи.
    for (const number of requestedNumbers) {
      if (article.number === number) {
        score += 35;
      }
    }

    return {
      article,
      score
    };
  });

  return ranked
      .filter(item => item.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }

        return String(a.article.document).localeCompare(
            String(b.article.document)
        );
      })
      .slice(0, limit)
      .map(item => item.article);
}

// =====================================================
// ПОДГОТОВКА НОРМ ДЛЯ ИИ
// =====================================================

function prepareLawsForAI(articles) {
  const selected = (articles || []).slice(0, 22);

  const maxArticleLength = 8000;
  const maxTotalLength = 55000;

  let output = "";
  let included = 0;

  for (const article of selected) {
    const body = [
      `ДОКУМЕНТ: ${article.document}`,
      article.chapter
          ? `ГЛАВА: ${article.chapter}`
          : "",
      article.section
          ? `РАЗДЕЛ: ${article.section}`
          : "",
      `СТАТЬЯ: ${article.number}`,
      article.title
          ? `НАЗВАНИЕ: ${article.title}`
          : "",
      article.status
          ? `СТАТУС: ${article.status}`
          : "",
      article.text
          ? `ТЕКСТ:\n${article.text}`
          : "",
      article.penalty
          ? `САНКЦИЯ:\n${article.penalty}`
          : "",
      article.exceptions
          ? `ИСКЛЮЧЕНИЯ:\n${article.exceptions}`
          : "",
      article.source
          ? `ИСТОЧНИК: ${article.source}`
          : ""
    ].filter(Boolean).join("\n");

    const shortened = body.length > maxArticleLength
        ? body.slice(0, maxArticleLength) +
        "\n[Текст сокращён из-за ограничения размера]"
        : body;

    const entry =
        shortened + "\n\n--------------------\n\n";

    if (output.length + entry.length > maxTotalLength) {
      break;
    }

    output += entry;
    included++;
  }

  if (!output) {
    return "Подходящие нормы в переданных документах не найдены.";
  }

  return [
    `НАЙДЕНО НОРМ: ${included}`,
    "Используй только приведённые ниже нормы.",
    "Не считай отсутствие нормы доказательством разрешения действия.",
    "",
    output
  ].join("\n");
}

// =====================================================
// API: ПОИСК ПО ЗАКОНОДАТЕЛЬСТВУ
// =====================================================

app.get("/api/laws/search", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();

    if (!query) {
      return res.status(400).json({
        error: "Укажи поисковый запрос."
      });
    }

    const lawData = await loadLaws();
    const documents = getDocuments(lawData);
    const allArticles = extractArticles(documents);

    const results = findRelevantArticles(
        allArticles,
        query,
        { limit: 40 }
    );

    res.json({
      query,
      totalDocuments: documents.length,
      totalArticles: allArticles.length,
      found: results.length,

      results: results.map(article => ({
        documentId: article.documentId,
        document: article.document,
        chapter: article.chapter,
        section: article.section,
        number: article.number,
        title: article.title,
        reference: article.reference,
        text: article.text,
        penalty: article.penalty,
        exceptions: article.exceptions
      }))
    });
  } catch (error) {
    console.error("Law search error:", error);

    res.status(500).json({
      error: "Ошибка поиска по законодательству."
    });
  }
});

// =====================================================
// ДЕТЕРМИНИРОВАННАЯ ПРОВЕРКА ССЫЛОК
// =====================================================

function extractReferenceNumbers(value) {
  const text = String(value || "");

  const matches = text.match(
      /(?:статья|статьи|ст\.?|пункт|пункта|п\.?)\s*№?\s*\d+(?:\.\d+)*/gi
  ) || [];

  return matches.map(match => {
    const number = match.match(/\d+(?:\.\d+)*/);

    return number ? number[0] : null;
  }).filter(Boolean);
}

function auditReferences(referenceTexts, allArticles) {
  const results = [];
  const seen = new Set();

  for (const reference of referenceTexts) {
    const text = String(reference || "").trim();

    if (!text) continue;

    const key = normalize(text);

    if (seen.has(key)) continue;

    seen.add(key);

    const numbers = extractReferenceNumbers(text);

    if (!numbers.length) {
      const normalizedReference = normalize(text);

      const candidates = allArticles.filter(article => {
        const combined = normalize(
            article.document + " " +
            article.chapter + " " +
            article.section + " " +
            article.number + " " +
            article.title
        );

        return (
            normalizedReference.length >= 5 &&
            combined.includes(normalizedReference)
        );
      });

      results.push({
        reference: text,

        status: candidates.length
            ? "Найдено совпадение"
            : "Не подтверждено",

        matches: candidates.slice(0, 3).map(article => ({
          document: article.document,
          chapter: article.chapter,
          section: article.section,
          number: article.number,
          title: article.title
        })),

        explanation: candidates.length
            ? "В базе найдено совпадение по названию."
            : "Не удалось однозначно сопоставить ссылку с записью в базе."
      });

      continue;
    }

    for (const number of numbers) {
      const matches = allArticles.filter(article =>
          normalize(article.number) === normalize(number)
      );

      results.push({
        reference: text,
        number,

        status: matches.length
            ? "Номер найден"
            : "Не найдено в базе",

        matches: matches.slice(0, 5).map(article => ({
          document: article.document,
          chapter: article.chapter,
          section: article.section,
          number: article.number,
          title: article.title
        })),

        explanation: matches.length
            ? "Номер присутствует в загруженной базе. Это подтверждает существование записи, но не правильность её толкования."
            : "В текущем laws.json не найдено положение с таким номером."
      });
    }
  }

  return results;
}

function collectReferencesFromChecks(checks) {
  const references = [];

  for (const item of checks || []) {
    if (Array.isArray(item.legalBasis)) {
      references.push(...item.legalBasis);
    }
  }

  return references;
}

function collectReferencesFromReasoning(items) {
  return (items || []).map(item => item.article || "");
}

function calculateAuditSummary(audit) {
  const confirmed = audit.filter(item =>
      item.status === "Номер найден" ||
      item.status === "Найдено совпадение"
  ).length;

  const unconfirmed = audit.filter(item =>
      item.status === "Не найдено в базе" ||
      item.status === "Не подтверждено"
  ).length;

  return {
    total: audit.length,
    confirmed,
    unconfirmed,

    status: unconfirmed > 0
        ? "Есть неподтверждённые ссылки"
        : audit.length
            ? "Ссылки сопоставлены с базой"
            : "Ссылки для проверки не указаны"
  };
}

// =====================================================
// ОБЩИЕ ИНСТРУКЦИИ ИИ
// =====================================================

function createInstructions({
                              mode,
                              caseData,
                              officerAnswer,
                              lawsForAI
                            }) {
  return `
Ты — RPM Attorney Assistant, помощник адвоката в ролевом проекте RPM.

Используй исключительно переданные нормативные документы RPM.
Не используй законодательство реальных стран.

ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:

1. Не придумывай статьи, пункты, сроки, полномочия и санкции.
2. Разделяй подтверждённые факты, предположения и неизвестные сведения.
3. Не выдавай отсутствие информации за доказательство нарушения.
4. Проверяй примечания, исключения и специальные правила.
5. Не делай вывод о виновности только по обвинению.
6. Если нужной нормы нет в переданных материалах, так и сообщи.
7. Не утверждай, что норма существует, если её текст не предоставлен.
8. Если статья найдена, указывай её точное название и документ.
9. Не считай незаконность одного действия автоматическим доказательством незаконности другого.
10. Если есть несколько возможных толкований, укажи это.

ПРАВИЛА ДОКАЗАТЕЛЬСТВ:

Для каждого доказательства оцени:
- Какой факт оно подтверждает.
- Известен ли источник.
- Известны ли обстоятельства получения.
- Есть ли сведения о подлинности и полноте.
- Есть ли сведения о соблюдении процедуры.
- Есть ли применимое исключение.
- Какие вопросы остаются открытыми.

ВАЖНОЕ ПРАВИЛО О ДОПУСТИМОСТИ:

Не утверждай, что доказательство автоматически исключается
из дела только из-за незаконности задержания.

Проверь отдельно:
- способ получения доказательства;
- законность самого обыска или другого действия;
- специальные правила и примечания;
- предусмотренные законом исключения.

Если в переданных нормах есть специальное исключение,
обязательно объясни его применимость к фактам.

МАТЕРИАЛЫ ДЕЛА:
${JSON.stringify(caseData, null, 2)}

ОТВЕТ СОТРУДНИКА:
${officerAnswer || "Не предоставлен"}

НАЙДЕННЫЕ НОРМЫ:
${lawsForAI}

РЕЖИМ: ${mode}

Верни СТРОГО JSON без Markdown:

{
  "answer": "Подробный анализ на русском языке",
  "legalReasoning": [
    {
      "article": "Точное название нормы и документа",
      "whyApplied": "Почему норма может применяться",
      "establishedElements": ["Подтверждённые факты"],
      "evidence": ["Конкретные доказательства"],
      "missingEvidence": ["Недостающие сведения"],
      "defenseArguments": ["Аргументы защиты"],
      "exceptions": ["Исключения и примечания"],
      "conclusion": "Недостаточно данных",
      "confidence": "Низкая",
      "confidenceReason": "Почему такая оценка"
    }
  ]
}

Допустимые значения conclusion:
- "Подтверждено"
- "Вероятно"
- "Недостаточно данных"
- "Не применимо"

Допустимые значения confidence:
- "Высокая"
- "Средняя"
- "Низкая"

РЕЖИМЫ:

analyze:
Проведи полный анализ дела. Заполни legalReasoning.
Если применимых норм нет, верни пустой массив.

evaluate_answer:
Оцени ответ сотрудника. Укажи установленные факты,
недостающие сведения, правовое значение и следующий вопрос.

followup:
Предложи уточняющие вопросы и дальнейшие действия адвоката.

questions:
Составь конкретные вопросы сотруднику и объясни их цель.

reference:
Подготовь памятку по заданному вопросу исключительно
на основании переданных норм.

ОТВЕЧАЙ НА РУССКОМ ЯЗЫКЕ.
`;
}

// =====================================================
// ПРОВЕРКА ДЕЙСТВИЙ ПОЛИЦИИ
// =====================================================

function createPoliceCheckInstructions({
                                         caseData,
                                         lawsForAI
                                       }) {
  return `
Ты — RPM Attorney Assistant.

Проведи правовую проверку действий полиции в ролевом проекте RPM.

Используй исключительно переданные нормы.
Не используй законодательство реальных стран.
Не придумывай статьи, пункты, сроки и полномочия.

МАТЕРИАЛЫ:
${JSON.stringify(caseData, null, 2)}

НОРМЫ RPM:
${lawsForAI}

Верни строго JSON без Markdown:

{
  "answer": "Общий вывод",
  "checks": [
    {
      "topic": "Основание задержания",
      "status": "Недостаточно данных",
      "legalBasis": [],
      "establishedFacts": [],
      "missingFacts": [],
      "explanation": "Анализ",
      "questions": [],
      "confidence": "Низкая",
      "confidenceReason": "Причина оценки"
    }
  ]
}

ПРОВЕРЬ:
1. Основание задержания.
2. Проникновение в помещение.
3. Проведение обыска.
4. Применение силы и специальных средств.
5. Права задержанного.
6. Процессуальные сроки.
7. Видеозаписи.
8. Допустимость доказательств.

Допустимые status:
- "Нарушение не выявлено"
- "Возможное нарушение"
- "Недостаточно данных"
- "Не применимо"

Допустимые confidence:
- "Высокая"
- "Средняя"
- "Низкая"

ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:

1. Указывай только реально переданные нормы.
2. Не придумывай номера статей и содержание законодательства.
3. Разделяй факты и предположения.
4. Для каждого вывода объясняй применимую норму.
5. Если информации недостаточно, укажи конкретные недостающие сведения.
6. Отсутствие ответа сотрудника не доказывает нарушение.
7. Не смешивай основания задержания с основаниями проникновения.
8. Основание для задержания само по себе не подтверждает право на проникновение.
9. Проверяй примечания, исключения и специальные правила.
10. Не объявляй доказательства недопустимыми без анализа порядка их получения.
11. Не утверждай, что незаконность задержания автоматически делает незаконным обыск.
12. Если специальная норма предусматривает исключение, обязательно рассмотри его.
13. Если нормы нет в переданных документах, прямо укажи это.
14. Не заполняй карточки выдуманными сведениями.
15. Не выдавай предположение за установленное нарушение.
16. Указывай уверенность в выводе и объясняй её.
17. Если правовая база неполная, снижай уверенность.
18. Если статус "Нарушение не выявлено", это не означает, что законность окончательно доказана.

Отвечай на русском языке.
`;
}

// =====================================================
// JSON PARSING
// =====================================================

function cleanJSON(raw) {
  return String(raw || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
}

function parseJSON(raw) {
  const text = cleanJSON(raw);

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(
          text.slice(start, end + 1)
      );
    }

    throw new Error("ИИ вернул некорректный JSON.");
  }
}

function safeArray(value) {
  return Array.isArray(value)
      ? value.map(String)
      : [];
}

function safeConfidence(value) {
  return [
    "Высокая",
    "Средняя",
    "Низкая"
  ].includes(value)
      ? value
      : "Низкая";
}

function parseAIAnalysis(raw) {
  const parsed = parseJSON(raw);

  const legalReasoning = Array.isArray(parsed.legalReasoning)
      ? parsed.legalReasoning.map(item => ({
        article: String(
            item.article || "Статья не указана"
        ),

        whyApplied: String(item.whyApplied || ""),

        establishedElements: safeArray(
            item.establishedElements
        ),

        evidence: safeArray(item.evidence),

        missingEvidence: safeArray(
            item.missingEvidence
        ),

        defenseArguments: safeArray(
            item.defenseArguments
        ),

        exceptions: safeArray(item.exceptions),

        conclusion: [
          "Подтверждено",
          "Вероятно",
          "Недостаточно данных",
          "Не применимо"
        ].includes(item.conclusion)
            ? item.conclusion
            : "Недостаточно данных",

        confidence: safeConfidence(item.confidence),

        confidenceReason: String(
            item.confidenceReason || ""
        )
      }))
      : [];

  return {
    answer: String(
        parsed.answer || "Анализ не получен."
    ),
    legalReasoning
  };
}

function parsePoliceCheck(raw) {
  const parsed = parseJSON(raw);

  const allowedStatuses = [
    "Нарушение не выявлено",
    "Возможное нарушение",
    "Недостаточно данных",
    "Не применимо"
  ];

  return {
    answer: String(
        parsed.answer || "Общий вывод не получен."
    ),

    checks: Array.isArray(parsed.checks)
        ? parsed.checks.map(item => ({
          topic: String(item.topic || "Проверка"),

          status: allowedStatuses.includes(item.status)
              ? item.status
              : "Недостаточно данных",

          legalBasis: safeArray(item.legalBasis),

          establishedFacts: safeArray(
              item.establishedFacts
          ),

          missingFacts: safeArray(
              item.missingFacts
          ),

          explanation: String(
              item.explanation || ""
          ),

          questions: safeArray(item.questions),

          confidence: safeConfidence(item.confidence),

          confidenceReason: String(
              item.confidenceReason || ""
          )
        }))
        : []
  };
}

// =====================================================
// ПРОВЕРКА ССЫЛОК В ОТВЕТЕ ИИ
// =====================================================

function addAuditToPoliceResult(result, allArticles) {
  const audit = auditReferences(
      collectReferencesFromChecks(result.checks),
      allArticles
  );

  return {
    ...result,
    referenceAudit: audit,
    auditSummary: calculateAuditSummary(audit)
  };
}

function addAuditToAnalysis(result, allArticles) {
  const audit = auditReferences(
      collectReferencesFromReasoning(result.legalReasoning),
      allArticles
  );

  return {
    ...result,
    referenceAudit: audit,
    auditSummary: calculateAuditSummary(audit)
  };
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
      "reference",
      "police_check"
    ];

    if (!allowedModes.includes(mode)) {
      return res.status(400).json({
        error: "Неизвестный режим анализа."
      });
    }

    // Используем законы интерфейса.
    // Если они не переданы, загружаем laws.json.
    const lawData = getDocuments(laws).length
        ? laws
        : await loadLaws();

    const documents = getDocuments(lawData);
    const allArticles = extractArticles(documents);

    let searchText = [
      caseData?.actionType,
      caseData?.policeDescription,
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

    const relevantArticles = findRelevantArticles(
        allArticles,
        searchText,
        { limit: 40 }
    );

    const lawsForAI = prepareLawsForAI(
        relevantArticles
    );

    console.log("AI request:", {
      mode,
      documents: documents.length,
      totalArticles: allArticles.length,
      selectedArticles: Math.min(
          relevantArticles.length,
          22
      )
    });

    const instructions = mode === "police_check"
        ? createPoliceCheckInstructions({
          caseData,
          lawsForAI
        })
        : createInstructions({
          mode,
          caseData,
          officerAnswer,
          lawsForAI
        });

    const completion = await client.chat.completions.create({
      model: MODEL,

      messages: [
        {
          role: "system",
          content: instructions
        },
        {
          role: "user",
          content: "Подготовь ответ по указанному режиму."
        }
      ],

      temperature: 0.1
    });

    const rawAnswer =
        completion.choices?.[0]?.message?.content ||
        "ИИ не вернул ответ.";

    if (mode === "analyze") {
      const result = parseAIAnalysis(rawAnswer);

      return res.json(
          addAuditToAnalysis(result, allArticles)
      );
    }

    if (mode === "police_check") {
      const result = parsePoliceCheck(rawAnswer);

      return res.json(
          addAuditToPoliceResult(result, allArticles)
      );
    }

    return res.json({
      answer: rawAnswer
    });

  } catch (error) {
    console.error("AI error:", error);

    res.status(
        error.status === 429 ? 429 : 500
    ).json({
      error: "Ошибка обращения к Gemini API: " +
          error.message
    });
  }
});

// =====================================================
// ИСТОРИЯ ДЕЛ
// =====================================================

app.get("/api/cases", async (req, res) => {
  const cases = await readJson(CASES_FILE, []);

  res.json(
      Array.isArray(cases) ? cases : []
  );
});

app.get("/api/case-backups", async (req, res) => {
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });

    const files = await fs.readdir(BACKUP_DIR);

    const backups = await Promise.all(
        files
            .filter(name => /^cases-.*\.json$/.test(name))
            .map(async name => {
              const filePath = path.join(BACKUP_DIR, name);
              const stats = await fs.stat(filePath);

              return {
                filename: name,
                size: stats.size,
                createdAt: stats.mtime.toISOString()
              };
            })
    );

    backups.sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt)
    );

    res.json(backups);

  } catch (error) {
    console.error("Load backups error:", error);

    res.status(500).json({
      error: error.message
    });
  }
});


app.post("/api/cases", async (req, res) => {
  try {
    const loaded = await readJson(CASES_FILE, []);
    const cases = Array.isArray(loaded) ? loaded : [];

    const item = {
      id: req.body.id || Date.now().toString(),
      title: req.body.title || "Новое дело",
      data: req.body.data || {},
      updatedAt: new Date().toISOString()
    };

    const index = cases.findIndex(
        c => c.id === item.id
    );

    if (index >= 0) {
      cases[index] = item;
    } else {
      cases.unshift(item);
    }

    await backupCases();
    await writeJson(CASES_FILE, cases);

    res.json(item);

  } catch (error) {
    console.error("Save case error:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

app.post("/api/case-backups/restore", async (req, res) => {
  try {
    const filename = req.body.filename;

    if (
        typeof filename !== "string" ||
        !/^cases-[\wT.-]+\.json$/.test(filename)
    ) {
      return res.status(400).json({
        error: "Некорректное имя резервной копии."
      });
    }

    const backupPath = path.join(BACKUP_DIR, filename);

    const backupData = JSON.parse(
        await fs.readFile(backupPath, "utf8")
    );

    if (!Array.isArray(backupData)) {
      return res.status(400).json({
        error: "Неверный формат резервной копии."
      });
    }

    await backupCases();
    await writeJson(CASES_FILE, backupData);

    res.json({
      success: true,
      restored: backupData.length
    });

  } catch (error) {
    console.error("Restore backup error:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

app.delete("/api/cases/:id", async (req, res) => {
  try {
    const loaded = await readJson(CASES_FILE, []);
    const cases = Array.isArray(loaded) ? loaded : [];

    await backupCases();

    await writeJson(
        CASES_FILE,
        cases.filter(c => c.id !== req.params.id)
    );

    res.json({
      success: true
    });
  } catch (error) {
    console.error("Delete case error:", error);

    res.status(500).json({
      error: error.message
    });
  }
});

// =====================================================
// СЕРВЕР И СОСТОЯНИЕ
// =====================================================

app.get("/api/health", async (req, res) => {
  try {
    const laws = await loadLaws();
    const documents = getDocuments(laws);
    const articles = extractArticles(documents);

    res.json({
      status: "ok",
      aiConfigured: Boolean(client),
      provider: "Google Gemini",
      model: MODEL,

      laws: {
        documents: documents.length,
        articles: articles.length
      }
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: error.message
    });
  }
});

// =====================================================
// ЗАПУСК
// =====================================================
app.listen(PORT, async () => {
  console.log("RPM Attorney Assistant запущен:");
  console.log(`http://localhost:${PORT}`);
  console.log("Модель:", MODEL);

  try {
    await backupCases();
    console.log("Проверка резервных копий завершена.");
  } catch(error) {
    console.error("Ошибка проверки резервных копий:", error);
  }
});