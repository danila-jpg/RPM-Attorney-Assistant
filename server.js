
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
// =====================================================
// ЗАЩИТА ПРИЛОЖЕНИЯ
// =====================================================

const APP_USER = process.env.APP_USER;
const APP_PASSWORD = process.env.APP_PASSWORD;

function safeCompare(a, b) {
  const first = Buffer.from(a);
  const second = Buffer.from(b);

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

  if (separator === -1) {
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

const LAWS_FILE = path.join(__dirname, "laws.json");
const CASES_FILE = path.join(__dirname, "cases.json");

app.use(requireAuth);
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const client = process.env.GEMINI_API_KEY
    ? new OpenAI({
      apiKey: process.env.GEMINI_API_KEY,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
    })
    : null;

const MODEL = process.env.OPENAI_MODEL || "gemini-3.1-flash-lite";

// =====================================================
// РАБОТА С JSON
// =====================================================

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
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

// =====================================================
// ЗАКОНЫ
// =====================================================

app.get("/api/laws", async (req, res) => {
  try {
    res.json(await readJson(LAWS_FILE, { documents: [] }));
  } catch (error) {
    res.status(500).json({
      error: "Не удалось загрузить законы: " + error.message
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

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      error: "Не удалось сохранить законы: " + error.message
    });
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
  try {
    res.json(await readJson(CASES_FILE, []));
  } catch (error) {
    res.status(500).json({
      error: "Не удалось загрузить дела: " + error.message
    });
  }
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
    res.status(500).json({
      error: "Не удалось сохранить дело: " + error.message
    });
  }
});

app.delete("/api/cases/:id", async (req, res) => {
  try {
    const cases = await readJson(CASES_FILE, []);

    const updated = cases.filter(
        c => c.id !== req.params.id
    );

    await writeJson(CASES_FILE, updated);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      error: "Не удалось удалить дело: " + error.message
    });
  }
});

// =====================================================
// НОРМАЛИЗАЦИЯ ТЕКСТА
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
  return normalize(value)
      .split(/\s+/)
      .filter(word => word.length >= 3);
}

// =====================================================
// ИЗВЛЕЧЕНИЕ СТАТЕЙ ИЗ ЗАКОНОВ
// =====================================================

function extractArticles(documents) {
  const result = [];

  function walk(node, documentName, depth = 0) {
    if (!node || typeof node !== "object" || depth > 10) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, documentName, depth + 1);
      }
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
      if (Array.isArray(node[key])) {
        walk(node[key], currentName, depth + 1);
      }
    }

    // Поддержка других вложенных структур
    if (!childKeys.some(key => Array.isArray(node[key]))) {
      for (const [key, value] of Object.entries(node)) {
        if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value)
        ) {
          walk(value, currentName, depth + 1);
        }
      }
    }
  }

  for (const doc of documents) {
    const documentName =
        doc.name ||
        doc.title ||
        "Неизвестный документ";

    walk(doc, documentName);
  }

  // Удаление дублей
  const unique = new Map();

  for (const article of result) {
    const key = normalize(
        article.document + article.title + article.text
    );

    if (!unique.has(key)) {
      unique.set(key, article);
    }
  }

  return [...unique.values()];
}

// =====================================================
// ПОИСК ТОЧНЫХ И РЕЛЕВАНТНЫХ СТАТЕЙ
// =====================================================

function findRelevantArticles(documents, searchText) {
  const articles = extractArticles(documents);
  const words = [...new Set(getWords(searchText))];

  if (!words.length) {
    return [];
  }

  // Находим номера статей в запросе
  const articleNumbers = [
    ...new Set(
        String(searchText).match(/\b\d+(?:\.\d+)+\b/g) || []
    )
  ];

  // Сначала ищем точные совпадения
  const exactMatches = articles.filter(article => {
    const title = normalize(article.title);

    return articleNumbers.some(number => {
      const escaped = number.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
      );

      const pattern = new RegExp(
          `(?:^|\\s)${escaped}(?:$|\\s)`
      );

      return pattern.test(title);
    });
  });

  const exactKeys = new Set(
      exactMatches.map(article =>
          normalize(
              article.document + article.title + article.text
          )
      )
  );

  // Затем выполняем обычный поиск
  const ranked = articles
      .filter(article =>
          !exactKeys.has(
              normalize(
                  article.document + article.title + article.text
              )
          )
      )
      .map(article => {
        const documentText = normalize(article.document);
        const titleText = normalize(article.title);
        const fullText = normalize(article.text);

        let score = 0;

        for (const word of words) {
          if (titleText.includes(word)) score += 5;
          if (documentText.includes(word)) score += 3;
          if (fullText.includes(word)) score += 1;
        }

        return {
          ...article,
          score
        };
      })
      .filter(article => article.score > 0)
      .sort((a, b) => b.score - a.score);

  return [...exactMatches, ...ranked];
}

// =====================================================
// ПОДГОТОВКА ЗАКОНОВ ДЛЯ ИИ
// =====================================================

function prepareLawsForAI(articles) {
  const MAX_ARTICLES = 12;
  const MAX_ARTICLE_LENGTH = 4500;
  const MAX_TOTAL_LENGTH = 30000;

  const selected = [];
  let totalLength = 0;

  for (const article of articles) {
    if (selected.length >= MAX_ARTICLES) {
      break;
    }

    const formatted = [
      `Документ: ${article.document}`,
      `Статья: ${article.title}`,
      `Текст: ${article.text.slice(0, MAX_ARTICLE_LENGTH)}`
    ].join("\n");

    if (totalLength + formatted.length > MAX_TOTAL_LENGTH) {
      continue;
    }

    selected.push(formatted);
    totalLength += formatted.length;
  }

  return selected.length
      ? selected.join("\n\n--------------------\n\n")
      : "Подходящие статьи с текстом не найдены.";
}

// =====================================================
// ИНСТРУКЦИИ ИИ
// =====================================================

function createInstructions({
                              mode,
                              caseData,
                              officerAnswer,
                              lawsForAI
                            }) {
  return `
Ты — RPM Attorney Assistant, помощник адвоката
в ролевом проекте RPM.

Твоя задача — помогать анализировать игровые
правовые ситуации на основании предоставленных
нормативных документов RPM.

ОСНОВНЫЕ ПРАВИЛА:

1. Используй только предоставленные законы RPM
   и материалы дела.
2. Не придумывай статьи, пункты, кодексы,
   сроки и полномочия.
3. Не приписывай статье содержание,
   которого нет в переданном тексте.
4. Разделяй подтверждённые факты,
   предположения и возможные нарушения.
5. Не объявляй действия сотрудника незаконными
   без достаточных оснований.
6. Если норма не найдена, сообщи:
   «По предоставленным материалам невозможно
   подтвердить наличие такой нормы».
7. Не требуй полного досье для проверки
   отдельного ответа.
8. Не путай отсутствие ответа, отказ от ответа
   и признание нарушения.
9. Не утверждай, что любое противоречие
   доказывает невиновность.
10. Не гарантируй освобождение или
    удовлетворение ходатайства.

ПРАВИЛА ЗАДЕРЖАНИЯ:

Различай:

А) сотрудник не смог назвать статью;
Б) статья отсутствует в материалах задержания;
В) фактического и законного основания
   задержания не существует.

Это разные обстоятельства.

Невозможность сотрудника назвать статью сама
по себе не доказывает незаконность задержания.

Если сотрудник не может назвать статью:

- оцени ответ как неполный;
- предложи уточнить статью и часть;
- выясни, где указано основание задержания;
- не придумывай норму вместо сотрудника.

Если правовое основание не подтверждается
материалами, рекомендуй запросить документы
и рассмотреть возможность ходатайства
об освобождении.

Не обещай автоматического освобождения.

ПРАВИЛА ПРОВЕРКИ СТАТЕЙ:

1. Ссылайся только на статьи, текст которых
   действительно передан.
2. УК 1.1 регулирует малозначительность.
   Не используй её для обоснования полномочий
   при задержании.
3. УК 13.4 о заведомо незаконном задержании
   можно рассматривать только при наличии
   подтверждающих фактов.
4. Одного незнания статьи сотрудником
   недостаточно для такого вывода.
5. Не утверждай, что сотрудник обязан объявить
   статью непосредственно в момент задержания,
   если такая норма не предоставлена.
6. Не приписывай Конституции права и обязанности,
   которых нет в её тексте.
7. Если процессуальный порядок не найден,
   сообщи об отсутствии достаточной информации.
8. Не называй ошибку в документе автоматическим
   доказательством незаконности задержания.

ПРАВИЛА ДОКАЗАТЕЛЬСТВ:

- Различай наличие доказательства и доказанность
  обстоятельства.
- Учитывай содержание, подлинность, полноту
  и относимость записи или показаний.
- Не называй доказательство бесспорным
  без проверки.
- Не делай окончательных выводов
  на основании предположений.

РЕЖИМ: ${mode}

МАТЕРИАЛЫ ДЕЛА:
${JSON.stringify(caseData, null, 2)}

ОТВЕТ СОТРУДНИКА:
${officerAnswer || "Не предоставлен"}

НАЙДЕННЫЕ ЗАКОНЫ RPM:
${lawsForAI}

ВАЖНО:

Если подходящая статья не найдена,
не придумывай её.

Если переданы только названия документов
без текста статей, сообщи, что проверить
содержание норм невозможно.

Совпадение слов не доказывает применимость статьи.

ТРЕБОВАНИЯ К РЕЖИМАМ:

Если режим analyze:

Проанализируй ситуацию, факты, возможные нарушения,
доказательства, противоречия и дальнейшие действия
адвоката.

Если режим evaluate_answer:

Проведи предметную проверку ответа сотрудника.

Используй структуру:

1. ОЦЕНКА ОТВЕТА
2. ЧТО УСТАНОВЛЕНО
3. ЧЕГО НЕ ХВАТАЕТ
4. ПРАВОВОЕ ЗНАЧЕНИЕ
5. СЛЕДУЮЩИЙ ВОПРОС
6. РЕКОМЕНДАЦИЯ АДВОКАТУ

ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА ПРОВЕРКИ:

- Не требуй от пользователя описания обстоятельств дела.
- Если указана статья, сначала найди её точное
  содержание среди переданных законов.
- Если сотрудник назвал номер статьи, проверь,
  соответствует ли его ответ содержанию этой статьи.
- Различай правильность номера статьи и доказанность
  самого нарушения.
- Если известен только номер статьи, объясни,
  что можно и чего нельзя установить по этому номеру.
- Если статья не найдена, сообщи об этом прямо.
- Не придумывай содержание статьи, её санкцию
  или дополнительные требования.
- Не объявляй ответ сотрудника неправильным
  без объяснения причины.
- Если данных недостаточно, укажи,
  какие сведения необходимо запросить.
- Не считай отсутствие ответа доказательством
  виновности или незаконности действий.
- Каждый следующий вопрос должен помогать получить
  конкретную недостающую информацию.
- Если передано несколько вопросов и ответов,
  оцени каждый отдельно.

Если режим followup:

Предложи следующие вопросы и действия
с учётом предыдущего ответа.

Если режим questions:

Составь список сложных, но корректных вопросов
сотруднику.

Объясни, что каждый вопрос помогает выяснить.

Если режим reference:

Подготовь практическую памятку адвокату
на основании переданных законов.

Не добавляй отсутствующие нормы.

ОТВЕЧАЙ НА РУССКОМ ЯЗЫКЕ.

Используй понятные заголовки
и нумерованные списки.
`;
}

// =====================================================
// ГЛАВНЫЙ ИИ-ОБРАБОТЧИК
// =====================================================

app.post("/api/attorney-assist", async (req, res) => {
  try {
    if (!client) {
      return res.status(503).json({
        error: "Gemini API не настроен. Проверь GEMINI_API_KEY в .env"
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

    // Подготавливаем поисковый запрос
    let searchText = "";

    switch (mode) {
      case "evaluate_answer":
        searchText = [
          caseData?.suspectedArticle,
          caseData?.article,
          caseData?.title,
          caseData?.description,
          caseData?.evidence,
          caseData?.accusation,
          officerAnswer
        ].filter(Boolean).join(" ");
        break;

      case "questions":
        searchText = [
          caseData?.suspectedArticle,
          caseData?.article,
          caseData?.description,
          caseData?.title,
          caseData?.accusation
        ].filter(Boolean).join(" ");
        break;

      case "reference":
        searchText = [
          caseData?.description,
          caseData?.title,
          caseData?.notes
        ].filter(Boolean).join(" ");
        break;

      default:
        searchText = [
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
    }

    // Поиск статей
    const relevantArticles = findRelevantArticles(
        documents,
        searchText
    );

    // Подготовка найденных законов
    const lawsForAI = prepareLawsForAI(
        relevantArticles
    );

    console.log("AI request:", {
      mode,
      documents: documents.length,
      totalArticles: extractArticles(documents).length,
      selectedArticles: Math.min(relevantArticles.length, 12),
      exactArticleNumbers: [
        ...new Set(
            String(searchText).match(/\b\d+(?:\.\d+)+\b/g) || []
        )
      ]
    });

    // Создание инструкции
    const instructions = createInstructions({
      mode,
      caseData,
      officerAnswer,
      lawsForAI
    });

    // Запрос к Gemini
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
      temperature: 0.4
    });

    const answer =
        completion.choices?.[0]?.message?.content ||
        "ИИ не вернул ответ.";

    res.json({ answer });

  } catch (error) {
    console.error("AI error:", error);

    const status = error.status === 429 ? 429 : 500;

    res.status(status).json({
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
