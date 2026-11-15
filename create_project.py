
import json
from pathlib import Path

documents = [
    {
        "id": "constitution",
        "name": "Конституция RPM",
        "category": "Конституция",
        "articles": []
    },
    {
        "id": "ak",
        "name": "Административный кодекс",
        "category": "Административное право",
        "articles": []
    },
    {
        "id": "uk",
        "name": "Уголовный кодекс",
        "category": "Уголовное право",
        "articles": []
    },
    {
        "id": "epk",
        "name": "Единый процессуальный кодекс",
        "category": "Процессуальное право",
        "articles": []
    },
    {
        "id": "advocacy",
        "name": "Закон об адвокатуре",
        "category": "Адвокатура",
        "articles": []
    },
    {
        "id": "emergency",
        "name": "Закон о чрезвычайном положении",
        "category": "Чрезвычайное положение",
        "articles": []
    },
    {
        "id": "social",
        "name": "Социальный кодекс",
        "category": "Социальное право",
        "articles": []
    },
    {
        "id": "business",
        "name": "Закон о частном предпринимательстве",
        "category": "Предпринимательство",
        "articles": []
    },
    {
        "id": "labor",
        "name": "Трудовой кодекс",
        "category": "Трудовое право",
        "articles": []
    },
    {
        "id": "warrants",
        "name": "Система ордеров",
        "category": "Процессуальное право",
        "articles": []
    },
    {
        "id": "judicial",
        "name": "Судебный кодекс",
        "category": "Судебная система",
        "articles": []
    },
    {
        "id": "access",
        "name": "Закон о доступе к государственным учреждениям",
        "category": "Государственные учреждения",
        "articles": []
    },
    {
        "id": "supervision",
        "name": "Административно-надзорный кодекс",
        "category": "Административное право",
        "articles": []
    }
]

# Пример формата статьи
documents[0]["articles"].append({
    "number": "1",
    "title": "Статус штата",
    "text": "Штат RPM является правовым субъектом в составе США.",
    "penalty": None,
    "status": "действует"
})

data = {
    "documents": documents
}

file_path = Path(__file__).parent / "laws.json"

with open(file_path, "w", encoding="utf-8") as file:
    json.dump(data, file, ensure_ascii=False, indent=2)

print("laws.json успешно создан!")
print(f"Путь: {file_path}")
