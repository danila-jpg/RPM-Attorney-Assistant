
import pg from "pg";
import bcrypt from "bcryptjs";
import { stdin, stdout } from "node:process";

const { Pool } = pg;

function readHidden(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Запусти скрипт в обычном интерактивном PowerShell.");
  }

  stdout.write(prompt);
  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Операция отменена."));
          return;
        }

        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }

        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }

        if (char >= " ") value += char;
      }
    };

    stdin.on("data", onData);
  });
}

const username = "quantummuse11";
const nickname = "QuantumMuse11";

let pool;

try {
  console.log("=== Создание владельца RPM Attorney Assistant ===");
  console.log("Логин: QuantumMuse11");
  console.log("Роль: admin");
  console.log("");

  const databaseUrl = await readHidden(
    "Вставь Production DATABASE_URL (ввод скрыт): "
  );

  let parsedUrl;

  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error("Некорректный DATABASE_URL.");
  }

  if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)) {
    throw new Error("Ожидается PostgreSQL DATABASE_URL.");
  }

  console.log("");
  console.log("Проверь подключение:");
  console.log("Хост:", parsedUrl.hostname);
  console.log("База:", parsedUrl.pathname.replace("/", ""));
  console.log("");
  console.log("Убедись, что это именно Production Neon,");
  console.log("а не тестовая база и не резервная ветка.");
  console.log("");

  const confirmation = await readHidden(
    "Для продолжения введи PRODUCTION: "
  );

  if (confirmation !== "PRODUCTION") {
    throw new Error("Подтверждение не получено. Операция отменена.");
  }

  const password = await readHidden("Придумай пароль (ввод скрыт): ");
  const passwordConfirmation = await readHidden("Повтори пароль: ");

  if (password !== passwordConfirmation) {
    throw new Error("Пароли не совпадают.");
  }

  const bytes = Buffer.byteLength(password, "utf8");

  if (bytes < 12 || bytes > 72) {
    throw new Error("Пароль должен занимать от 12 до 72 байт UTF-8.");
  }

  pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10000
  });

  const check = await pool.query(
    "SELECT current_database() AS db, current_user AS db_user"
  );

  console.log("");
  console.log("Подключение установлено к базе:", check.rows[0].db);

  const existing = await pool.query(
    "SELECT id FROM rpm_users WHERE LOWER(username) = $1",
    [username]
  );

  if (existing.rowCount > 0) {
    throw new Error("Аккаунт QuantumMuse11 уже существует. Ничего не изменено.");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await pool.query(
    `INSERT INTO rpm_users
       (username, password_hash, rp_nickname, status, role)
     VALUES ($1, $2, $3, 'active', 'admin')
     RETURNING id, username, rp_nickname, status, role`,
    [username, passwordHash, nickname]
  );

  console.log("");
  console.log("Владелец успешно создан:");
  console.log(result.rows[0]);
  console.log("Теперь можно войти через страницу администратора.");
} catch (error) {
  console.error("");
  console.error("Операция не выполнена:", error.message);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
