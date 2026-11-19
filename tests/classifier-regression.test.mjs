import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const html = fs.readFileSync("public/index.html", "utf8");
const scriptMatch = html.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/i);

if (!scriptMatch) {
  throw new Error("Не найден встроенный JavaScript.");
}

const source = scriptMatch[1];

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);

  if (start < 0 || end < 0) {
    throw new Error(`Не найдена функция: ${startMarker}`);
  }

  return source.slice(start, end);
}

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag;
    this.className = "";
    this.children = [];
    this._text = "";
    this.classList = {
      remove: () => {}
    };
  }

  set textContent(value) {
    this._text = String(value ?? "");
    this.children = [];
  }

  get textContent() {
    return this._text + this.children
      .map(child => child.textContent ?? "")
      .join("");
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this._text = "";
    this.children = [...children];
  }
}

const output = new FakeElement("div");

const context = {
  document: {
    createElement: tag => new FakeElement(tag),
    createTextNode: text => ({ textContent: String(text) })
  },

  $: id => id === "result" ? output : null,

  makeElement: (tag, className, text) => {
    const element = new FakeElement(tag);
    element.className = className || "";

    if (text !== undefined) {
      element.textContent = text;
    }

    return element;
  }
};

const selectedFunctions = [
  extract("function categoryByName(name){", "function normalizeMarkdownLine(line){"),
  extract("function normalizeMarkdownLine(line){", "function getHeadingCategory(line){"),
  extract("function getHeadingCategory(line){", "function appendFormattedText(container,text){"),
  extract("function appendFormattedText(container,text){", "function classifyResultSentence(sentence){"),
  extract("function classifyResultSentence(sentence){", "/* АНАЛИЗ ИИ */")
].join("\n");

vm.runInNewContext(selectedFunctions, context);

const sentenceTests = [
  ["Действие не допускается.", "yellow"],
  ["Действие не является законным.", "yellow"],
  ["Недостаточно данных для вывода.", "yellow"],
  ["Возможно нарушение закона.", "yellow"],
  ["Выявлено нарушение установленного порядка.", "yellow"],
  ["Действие прямо разрешено законом.", "yellow"],
  ["Рекомендуется адвокату запросить документы.", "purple"],
  ["Согласно статье 10 кодекса.", "blue"],
  ["Нарушение не установлено.", "yellow"],
  ["Действие не является нарушением.", "yellow"]
];

for (const [sentence, expected] of sentenceTests) {
  assert.equal(
    context.classifyResultSentence(sentence),
    expected,
    `Ошибка классификации: "${sentence}"`
  );
}

const headingTests = [
  ["## РАЗРЕШЕНО / ЗАКОННО", "yellow"],
  ["## ВОЗМОЖНОЕ НАРУШЕНИЕ", "yellow"],
  ["## ПРАВОВЫЕ ОСНОВАНИЯ", "blue"],
  ["## РЕКОМЕНДАЦИИ АДВОКАТУ", "purple"],
  ["## НЕДОСТАТОЧНО ДАННЫХ", "yellow"]
];

for (const [heading, expected] of headingTests) {
  const result = context.getHeadingCategory(heading);

  assert.ok(result, `Заголовок не распознан: ${heading}`);
  assert.equal(
    result.category.className,
    context.categoryByName(expected).className
  );
}

// Проверяем отображение ответа с заголовками
const headedAnswer = [
  "## РАЗРЕШЕНО / ЗАКОННО",
  "Действие прямо разрешено законом.",
  "## Правовые основания",
  "Согласно статье 10 кодекса.",
  "## Рекомендации адвокату",
  "Рекомендуется адвокату запросить документы."
].join("\n");

context.showResult("result", headedAnswer);

const headedClasses = output.children.map(item => item.className);
const headedText = output.textContent;

assert.ok(headedClasses.some(className => className.split(/\s+/).includes("result-yellow")));
assert.ok(headedClasses.some(className => className.split(/\s+/).includes("result-blue")));
assert.ok(headedClasses.some(className => className.split(/\s+/).includes("result-purple")));
assert.ok(!headedClasses.some(className => className.split(/\s+/).includes("result-green")));
assert.ok(!headedClasses.some(className => className.split(/\s+/).includes("result-red")));

assert.ok(headedText.includes("Действие прямо разрешено законом."));
assert.ok(headedText.includes("Согласно статье 10 кодекса."));
assert.ok(headedText.includes("Рекомендуется адвокату запросить документы."));
assert.ok(!headedText.includes("РАЗРЕШЕНО / ЗАКОННО"));

// Проверяем ответ без заголовков
context.showResult(
  "result",
  "Возможно нарушение закона.\nСогласно статье 10 кодекса."
);

assert.ok(output.children.some(item => item.className.split(/\s+/).includes("result-yellow")));
assert.ok(output.children.some(item => item.className.split(/\s+/).includes("result-blue")));

console.log(`PASS: ${sentenceTests.length} sentence tests`);
console.log(`PASS: ${headingTests.length} heading tests`);
console.log("PASS: showResult heading tests");
console.log("PASS: showResult plain-text tests");
console.log("PASS: classifier regression tests");