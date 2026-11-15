
import json
import shutil
from pathlib import Path
from datetime import datetime

file = Path("laws.json")

names_to_delete = {
    "закон о чрезвычайном положении",
    "закон о частном предпринимательстве",
    "закон о доступе к государственным учреждениям"
}

def normalize(value):
    return value.lower().replace("ё", "е").strip()

with file.open("r", encoding="utf-8") as f:
    data = json.load(f)

backup = Path(
    f"laws_before_delete_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
)
shutil.copy2(file, backup)

before = len(data["documents"])

data["documents"] = [
    doc for doc in data["documents"]
    if normalize(doc.get("name", "")) not in names_to_delete
]

deleted = before - len(data["documents"])

with file.open("w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print(f"Удалено документов: {deleted}")
print(f"Осталось документов: {len(data['documents'])}")
print(f"Резервная копия: {backup}")
