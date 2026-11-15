
import json
import re
import shutil
from pathlib import Path
from datetime import datetime

BASE = Path(__file__).resolve().parent
FILE = BASE / "laws.json"

if not FILE.exists():
    raise FileNotFoundError("Не найден laws.json")

# Читаем исходные данные
with FILE.open("r", encoding="utf-8") as f:
    data = json.load(f)

# Создаём резервную копию
backup = BASE / f"laws_backup_{datetime.now():%Y%m%d_%H%M%S}.json"
shutil.copy2(FILE, backup)

article_pattern = re.compile(
    r"^\s*Статья\s+(\d+(?:\.\d+)*)\s*[.:]\s*(.*?)\s*$",
    re.IGNORECASE
)

chapter_pattern = re.compile(
    r"^\s*Глава\s+(.+?)\s*$",
    re.IGNORECASE
)

def clean_line(line):
    line = line.strip()

    # Убираем технические строки экспорта Discord
    if line == "TC":
        return ""

    if re.search(r"—\s*\d{2}\.\d{2}\.\d{4}\s+\d{1,2}:\d{2}", line):
        return ""

    if "Значок роли" in line:
        return ""

    return line


def parse_document(full_text):
    lines = full_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    sections = []
    current_section = {
        "number": "",
        "title": "Общие положения",
        "articles": []
    }

    current_article = None
    found_articles = 0

    def save_article():
        nonlocal current_article

        if current_article is None:
            return

        current_article["text"] = "\n".join(
            current_article.pop("_body")
        ).strip()

        current_article["penalty"] = None
        current_article["status"] = "действует"

        current_section["articles"].append(current_article)
        current_article = None

    def save_section():
        nonlocal current_section

        save_article()

        if current_section["articles"]:
            sections.append(current_section)

    for raw_line in lines:
        line = clean_line(raw_line)

        if not line:
            continue

        # Заголовок главы
        chapter_match = chapter_pattern.match(line)

        if chapter_match:
            save_section()

            chapter_title = chapter_match.group(1).strip()
            current_section = {
                "number": "",
                "title": chapter_title,
                "articles": []
            }

            continue

        # Заголовок статьи
        article_match = article_pattern.match(line)

        if article_match:
            save_article()

            number = article_match.group(1)
            title = article_match.group(2).strip()

            current_article = {
                "number": number,
                "title": title.rstrip("."),
                "_body": []
            }

            found_articles += 1
            continue

        # Текст текущей статьи
        if current_article is not None:
            current_article["_body"].append(line)

    save_section()

    # Если статьи обнаружены, собираем общий список
    articles = []

    for section in sections:
        articles.extend(section["articles"])

    return articles, sections, found_articles


changed = 0

for document in data.get("documents", []):
    full_text = document.get("fullText", "")

    if not isinstance(full_text, str) or not full_text.strip():
        continue

    # Не перезаписываем уже заполненные документы
    if document.get("articles"):
        continue

    articles, sections, count = parse_document(full_text)

    if count == 0:
        print(f"[ПРОПУСК] {document.get('name')}: статьи не распознаны")
        continue

    document["articles"] = articles
    document["sections"] = sections

    changed += 1

    print(
        f"[ГОТОВО] {document.get('name')}: "
        f"{len(articles)} статей, {len(sections)} глав"
    )

data["updatedAt"] = datetime.now().isoformat(timespec="seconds")

# Сохраняем результат
with FILE.open("w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print("\nИмпорт завершён.")
print("Обработано документов:", changed)
print("Резервная копия:", backup.name)
print("Исходные fullText сохранены.")
