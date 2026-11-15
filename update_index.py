
from pathlib import Path

file = Path("public/index.html")

if not file.exists():
    raise SystemExit("Не найден public/index.html. Запусти скрипт из папки проекта.")

html = file.read_text(encoding="utf-8")

def replace_once(old, new, description):
    global html
    if old not in html:
        raise SystemExit("Не удалось найти участок: " + description)
    html = html.replace(old, new, 1)
    print("Добавлено:", description)

# 1. CSS панели

replace_once(
    "    @media(max-width:700px){",
    """
    .analysis-layout {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(280px, 1fr);
      gap: 16px;
      align-items: start;
      margin-top: 18px;
    }

    .analysis-layout > .result {
      margin-top: 0;
      min-width: 0;
    }

    .reasoning-panel {
      background: #151121;
      border: 1px solid #67439a;
      border-radius: 12px;
      padding: 16px;
      min-width: 0;
    }

    .reasoning-panel h2 {
      color: #d3b5ff;
      margin: 0 0 8px;
    }

    .reasoning-card {
      background: #211832;
      border: 1px solid #49345f;
      border-radius: 9px;
      padding: 13px;
      margin-top: 12px;
      overflow-wrap: anywhere;
    }

    .reasoning-card h3 {
      color: #d8baff;
      margin: 0 0 10px;
    }

    .reasoning-field {
      margin-top: 12px;
      line-height: 1.55;
      font-size: 13px;
    }

    .reasoning-field strong {
      display: block;
      color: #c49aff;
      margin-bottom: 4px;
    }

    .reasoning-field ul {
      padding-left: 19px;
      margin: 5px 0;
    }

    .reasoning-status {
      display: inline-block;
      border-radius: 7px;
      padding: 6px 9px;
      margin-top: 8px;
      font-size: 12px;
      background: #302044;
      color: #d8baff;
    }

    .reasoning-empty {
      color: #aa9cbd;
      line-height: 1.6;
      font-size: 13px;
    }

    @media(max-width:850px) {
      .analysis-layout {
        grid-template-columns: 1fr;
      }
    }

    @media(max-width:700px){""",
    "CSS панели обоснования"
)

# 2. Разметка панели

replace_once(
    '<div id="analysisResult" class="result hidden"></div>',
    """
      <div class="analysis-layout">
        <div id="analysisResult" class="result hidden"></div>

        <aside id="legalReasoningPanel" class="reasoning-panel">
          <h2>Обоснование обвинения</h2>
          <p class="reasoning-empty">
            После анализа здесь появятся применимые статьи,
            доказательства, исключения и аргументы защиты.
          </p>
        </aside>
      </div>
""",
    "HTML панели обоснования"
)

# 3. Переменная состояния

replace_once(
    '  let lastAnalysis="";',
    '  let lastAnalysis="";\n  let lastLegalReasoning=[];',
    "состояние обоснования"
)

# 4. Функция отображения карточек

marker = '  /* СОХРАНЕНИЕ ДЕЛ */'

render_function = r'''
  /* ОБОСНОВАНИЕ ПРИМЕНЕНИЯ СТАТЕЙ */

  function renderLegalReasoning(items) {
    const panel = $("legalReasoningPanel");
    if (!panel) return;

    panel.replaceChildren();

    panel.appendChild(
      makeElement("h2", "", "Обоснование обвинения")
    );

    if (!Array.isArray(items) || !items.length) {
      panel.appendChild(makeElement(
        "p",
        "reasoning-empty",
        "ИИ не указал применимых статей. Это может означать, что подходящие нормы не найдены или предоставленных материалов недостаточно."
      ));
      return;
    }

    function addField(card, title, value) {
      const field = makeElement("div", "reasoning-field");
      field.appendChild(makeElement("strong", "", title));

      if (Array.isArray(value)) {
        if (!value.length) {
          field.appendChild(makeElement("span", "", "Не указано."));
        } else {
          const ul = document.createElement("ul");

          value.forEach(item => {
            ul.appendChild(makeElement("li", "", item));
          });

          field.appendChild(ul);
        }
      } else {
        field.appendChild(makeElement(
          "div",
          "",
          value || "Не указано."
        ));
      }

      card.appendChild(field);
    }

    items.forEach(item => {
      const card = makeElement("div", "reasoning-card");

      card.appendChild(makeElement(
        "h3",
        "",
        item.article || "Статья не указана"
      ));

      const status = makeElement(
        "span",
        "reasoning-status",
        item.conclusion || "Недостаточно данных"
      );

      card.appendChild(status);

      addField(card, "Почему применяется", item.whyApplied);
      addField(card, "Подтверждённые признаки", item.establishedElements);
      addField(card, "Подтверждающие доказательства", item.evidence);
      addField(card, "Недостающие доказательства", item.missingEvidence);
      addField(card, "Аргументы защиты", item.defenseArguments);
      addField(card, "Исключения и примечания", item.exceptions);

      panel.appendChild(card);
    });
  }

'''

replace_once(
    marker,
    render_function + marker,
    "функция отображения обоснования"
)

# 5. Получение ответа ИИ

replace_once(
    """      const answer=data.answer||data.message||"Ответ не получен.";
      showResult(target,answer);

      if(mode==="analyze")lastAnalysis=answer;""",
    """      const answer=data.answer||data.message||"Ответ не получен.";
      showResult(target,answer);

      if(mode==="analyze") {
        lastAnalysis=answer;
        lastLegalReasoning=Array.isArray(data.legalReasoning)
          ? data.legalReasoning
          : [];
        renderLegalReasoning(lastLegalReasoning);
      }""",
    "обработка ответа анализа"
)

# 6. Сохранение обоснования вместе с делом

replace_once(
    'data:{...data,analysis:lastAnalysis}',
    'data:{...data,analysis:lastAnalysis,legalReasoning:lastLegalReasoning}',
    "сохранение обоснования в истории"
)

# 7. Восстановление обоснования при открытии дела

replace_once(
    """    lastAnalysis=data.analysis||"";

    if(lastAnalysis)showResult("analysisResult",lastAnalysis);""",
    """    lastAnalysis=data.analysis||"";

    lastLegalReasoning=Array.isArray(data.legalReasoning)
      ? data.legalReasoning
      : [];

    if(lastAnalysis)showResult("analysisResult",lastAnalysis);

    renderLegalReasoning(lastLegalReasoning);""",
    "восстановление обоснования из истории"
)

# 8. Запись файла

file.write_text(html, encoding="utf-8")

print()
print("Обновление завершено!")
print("Файл:", file.resolve())
print("Теперь перезапусти сервер и обнови страницу через Ctrl + F5.")
