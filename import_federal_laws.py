import json
from pathlib import Path

BASE = Path(__file__).resolve().parent
LAWS_FILE = BASE / "laws.json"
IMPORT_FILE = BASE / "federal_laws.json"

if not LAWS_FILE.exists():
    raise SystemExit(f"Не найден файл: {LAWS_FILE}")
if not IMPORT_FILE.exists():
    raise SystemExit(f"Не найден файл: {IMPORT_FILE}")

laws = json.loads(LAWS_FILE.read_text(encoding="utf-8"))
source = json.loads(IMPORT_FILE.read_text(encoding="utf-8"))

documents = laws.setdefault("documents", [])
by_id = {doc.get("id"): i for i, doc in enumerate(documents)}
added = 0
updated = 0
for doc in source.get("documents", []):
    if doc.get("id") in by_id:
        documents[by_id[doc["id"]]] = doc
        updated += 1
    else:
        documents.append(doc)
        by_id[doc["id"]] = len(documents) - 1
        added += 1

laws["updatedAt"] = __import__("datetime").datetime.now().isoformat(timespec="seconds")
laws["sourceImports"] = laws.get("sourceImports", [])
if "Текстовый документ.txt" not in laws["sourceImports"]:
    laws["sourceImports"].append("Текстовый документ.txt")

# Сохраняем резервную копию перед изменением.
backup = BASE / "laws.backup.json"
backup.write_text(json.dumps(json.loads(LAWS_FILE.read_text(encoding="utf-8")), ensure_ascii=False, indent=2), encoding="utf-8")
LAWS_FILE.write_text(json.dumps(laws, ensure_ascii=False, indent=2), encoding="utf-8")
print("Импорт завершён.")
print(f"Добавлено документов: {added}")
print(f"Обновлено документов: {updated}")
print(f"Всего документов в laws.json: {len(documents)}")
print(f"Резервная копия: {backup}")
