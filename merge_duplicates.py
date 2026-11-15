
import json
import shutil
import re
from pathlib import Path
from datetime import datetime

FILE = Path("laws.json")

if not FILE.exists():
    raise FileNotFoundError("Не найден laws.json")

with FILE.open("r", encoding="utf-8") as f:
    data = json.load(f)

# Резервная копия
backup = Path(
    f"laws_before_merge_{datetime.now():%Y%m%d_%H%M%S}.json"
)
shutil.copy2(FILE, backup)


def normalize(name):
    name = name.lower().replace("ё", "е").replace("‑", "-")
    name = re.sub(r"\s+", " ", name)
    return name.strip()


groups = {}

for document in data.get("documents", []):
    key = normalize(document.get("name", ""))
    groups.setdefault(key, []).append(document)


merged_documents = []
removed = 0

for name, documents in groups.items():
    if len(documents) == 1:
        merged_documents.append(documents[0])
        continue

    # Сначала выбираем запись с наибольшим количеством содержимого
    documents.sort(
        key=lambda x: (
            len(x.get("articles", [])),
            len(x.get("fullText", "")),
            len(x.get("sections", []))
        ),
        reverse=True
    )

    richest = documents[0]

    # Сохраняем ID первой записи, чтобы не менять её идентификатор
    original_id = documents[-1].get("id")

    merged = dict(documents[-1])

    # Переносим содержимое из наиболее полной записи
    for key, value in richest.items():
        if key == "id":
            continue

        if value not in (None, "", [], {}):
            merged[key] = value

    merged["id"] = original_id

    # Дополнительно проверяем, что статьи не потерялись
    if not merged.get("articles"):
        for document in documents:
            if document.get("articles"):
                merged["articles"] = document["articles"]
                break

    if not merged.get("fullText"):
        for document in documents:
            if document.get("fullText"):
                merged["fullText"] = document["fullText"]
                break

    merged_documents.append(merged)
    removed += len(documents) - 1

    print(
        f"[ОБЪЕДИНЕНО] {merged.get('name')}: "
        f"{len(merged.get('articles', []))} статей"
    )

data["documents"] = merged_documents
data["updatedAt"] = datetime.now().isoformat(timespec="seconds")

with FILE.open("w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print("\nОбъединение завершено!")
print("Удалено пустых дубликатов:", removed)
print("Всего документов:", len(merged_documents))
print("Резервная копия:", backup)
