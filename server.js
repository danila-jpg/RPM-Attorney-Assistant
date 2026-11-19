import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import bcrypt from "bcryptjs";
import { timingSafeEqual, randomBytes, createHash, randomUUID } from "node:crypto";
import registerCustomerAuth from "./customer-auth-routes.js";

dotenv.config();

const PgSession = connectPgSimple(session);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LAWS_FILE = path.join(__dirname, "laws.json");
const CASES_FILE = path.join(__dirname, "cases.json");

const APP_USER = process.env.APP_USER;
const APP_PASSWORD = process.env.APP_PASSWORD;
const OWNER_USER = String(process.env.OWNER_USER || "quantummuse").trim().toLowerCase();
const MODEL = process.env.OPENAI_MODEL || "gemini-3.1-flash-lite";

const client = process.env.GEMINI_API_KEY
    ? new OpenAI({
      apiKey: process.env.GEMINI_API_KEY,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
    })
    : null;

// =====================================================
// РАБОТА С ИСТОРИЕЙ ДЕЛ В POSTGRESQL
// =====================================================

async function getCasesFromDB(userId, db = pool) {
  if (!userId) {
    throw new Error("Не удалось определить владельца дел.");
  }

  const result = await db.query(
    `SELECT id, title, data, updated_at
     FROM rpm_cases
     WHERE user_id = $1
     ORDER BY updated_at DESC`,
    [userId]
  );

  return result.rows.map(row => ({
    id: row.id,
    title: row.title,
    data: row.data,
    updatedAt: row.updated_at
  }));
}

async function backupCasesDB(userId, db = pool) {
  const cases = await getCasesFromDB(userId, db);

  if (cases.length === 0) {
    return;
  }

  await db.query(
    `INSERT INTO rpm_case_backups (user_id, cases)
     VALUES ($1, $2::jsonb)`,
    [userId, JSON.stringify(cases)]
  );

  await db.query(
    `DELETE FROM rpm_case_backups
     WHERE user_id = $1
       AND id NOT IN (
         SELECT id
         FROM rpm_case_backups
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 30
       )`,
    [userId]
  );
}

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

let ownerLegacyCasesMigrationComplete = false;
let ownerLegacyCasesMigrationPromise = null;

async function migrateLegacyCasesToOwner(userId) {
  if (!userId || ownerLegacyCasesMigrationComplete) return;
  if (ownerLegacyCasesMigrationPromise) {
    await ownerLegacyCasesMigrationPromise;
    return;
  }

  ownerLegacyCasesMigrationPromise = (async () => {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(7342151)");
      await db.query(
        `UPDATE rpm_cases
         SET user_id = $1
         WHERE user_id IS NULL`,
        [userId]
      );
      await db.query(
        `UPDATE rpm_case_backups
         SET user_id = $1
         WHERE user_id IS NULL`,
        [userId]
      );
      await db.query("COMMIT");
      ownerLegacyCasesMigrationComplete = true;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  })();

  try {
    await ownerLegacyCasesMigrationPromise;
  } finally {
    ownerLegacyCasesMigrationPromise = null;
  }
}

async function getOrCreateBasicAuthUserId(username, password) {
  const db = await pool.connect();

  try {
    await db.query("BEGIN");
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext(lower($1))::bigint)",
      [username]
    );

    const existing = await db.query(
      `SELECT id, role, status
       FROM rpm_users
       WHERE lower(username) = lower($1)
       LIMIT 1
       FOR UPDATE`,
      [username]
    );

    if (existing.rowCount) {
      const account = existing.rows[0];

      if (account.role !== "admin" || account.status !== "active") {
        throw new Error("Basic Auth account must be an active administrator.");
      }

      await db.query("COMMIT");
      return account.id;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const created = await db.query(
      `INSERT INTO rpm_users
         (username, password_hash, rp_nickname, role, status)
       VALUES ($1, $2, $1, 'admin', 'active')
       RETURNING id`,
      [username, passwordHash]
    );

    await db.query("COMMIT");
    return created.rows[0].id;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

async function requireAuth(req, res, next) {
  // Администраторская сессия: роль и устройство перепроверяются в БД.
  if (req.session?.userId && req.session?.deviceId) {
    const cookieHeader = req.headers.cookie || "";
    const deviceCookie = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("rpm.device="));

    const token = deviceCookie
      ? deviceCookie.slice("rpm.device=".length)
      : "";

    if (/^[a-f0-9]{64}$/.test(token)) {
      try {
        const tokenHash = createHash("sha256")
          .update(token)
          .digest("hex");

        const adminResult = await pool.query(
          `UPDATE rpm_devices d
           SET last_seen_at = NOW()
           FROM rpm_users u
           WHERE d.id = $1
             AND d.user_id = $2
             AND d.device_token_hash = $3
             AND d.revoked_at IS NULL
             AND u.id = d.user_id
             AND u.status = 'active'
             AND u.role = 'admin'
           RETURNING u.id, u.username`,
          [req.session.deviceId, req.session.userId, tokenHash]
        );

        if (adminResult.rowCount) {
          req.userId = adminResult.rows[0].id;
          req.isAdmin = true;
          req.isCustomer = false;
          req.isOwner = String(adminResult.rows[0].username || "").trim().toLowerCase() === OWNER_USER;
          if (req.isOwner) {
            try {
              await migrateLegacyCasesToOwner(req.userId);
            } catch (error) {
              console.error("Legacy case ownership migration error:", error);
              return res.status(503).send("Не удалось перенести старые дела в аккаунт владельца.");
            }
          }
          return next();
        }
      } catch (error) {
        console.error("Admin session verification error:", error);
      }
    }
  }

  // Покупатель может открыть панель помощника только с активной лицензией
  // и подтверждённым устройством. Администраторская авторизация выше имеет приоритет.
  if (req.session?.userId && req.session?.deviceId) {
    const cookieHeader = req.headers.cookie || "";
    const deviceCookie = cookieHeader.split(";").map((part) => part.trim())
      .find((part) => part.startsWith("rpm.device="));
    const token = deviceCookie ? deviceCookie.slice("rpm.device=".length) : "";
    if (/^[a-f0-9]{64}$/.test(token)) {
      try {
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const customerResult = await pool.query(
          `SELECT u.id, u.username
           FROM rpm_devices d
           JOIN rpm_users u ON u.id = d.user_id
           WHERE d.id = $1 AND d.user_id = $2
             AND d.device_token_hash = $3 AND d.revoked_at IS NULL
             AND u.status = 'active' AND u.role = 'customer'
             AND EXISTS (
               SELECT 1 FROM rpm_licenses l
               WHERE l.user_id = u.id AND l.status = 'active'
                 AND l.starts_at <= NOW() AND l.expires_at > NOW()
             )
           LIMIT 1`,
          [req.session.deviceId, req.session.userId, tokenHash]
        );
        if (customerResult.rowCount) {
          req.userId = customerResult.rows[0].id;
          req.isAdmin = false;
          req.isOwner = false;
          req.isCustomer = true;
          await pool.query("UPDATE rpm_devices SET last_seen_at = NOW() WHERE id = $1", [req.session.deviceId]);
          return next();
        }
      } catch (error) {
        console.error("Customer panel session verification error:", error);
        return res.status(503).send("Не удалось проверить доступ к панели.");
      }
    }
  }

  // Существующий Basic Auth остаётся резервным способом входа.
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

  try {
    req.userId = await getOrCreateBasicAuthUserId(username, password);
  } catch (error) {
    console.error("Basic Auth account mapping error:", error);
    return res.status(503).send("Не удалось определить аккаунт администратора.");
  }

  req.isAdmin = true;
  req.isCustomer = false;
  req.isOwner = String(username || "").trim().toLowerCase() === OWNER_USER;
  if (req.isOwner) {
    try {
      await migrateLegacyCasesToOwner(req.userId);
    } catch (error) {
      console.error("Legacy case ownership migration error:", error);
      return res.status(503).send("Не удалось перенести старые дела в аккаунт владельца.");
    }
  }
  next();
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 64) {
  throw new Error("SESSION_SECRET is missing or too short.");
}

app.set("trust proxy", 1);

app.use(express.json({ limit: "5mb" }));

app.use(session({
  name: "rpm.sid",
  store: new PgSession({
    pool,
    tableName: "rpm_sessions",
    createTableIfMissing: false
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: "auto",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

registerCustomerAuth(app, pool);

app.use("/app", express.static(path.join(__dirname, "customer")));

app.use(requireAuth);

function requireAdmin(req, res, next) {
  if (req.isAdmin === true) return next();
  return res.status(403).json({ success: false, message: "Доступ только для сотрудников." });
}

function requireOwner(req, res, next) {
  if (req.isOwner === true) return next();
  return res.status(403).json({ success: false, message: "Доступ запрещён." });
}

app.get("/api/panel/permissions", (req, res) => {
  res.json({ success: true, isAdmin: req.isAdmin === true, isOwner: req.isOwner === true, isCustomer: req.isCustomer === true });
});

app.get("/api/panel/profile", async (req,res)=>{
  try {
    const result=await pool.query(`SELECT username,rp_nickname,COALESCE(display_name,rp_nickname) AS display_name,
      avatar_data,COALESCE(theme,'quantum-purple') AS theme FROM rpm_users WHERE id=$1 AND status='active'`,[req.userId]);
    if(!result.rowCount) return res.status(404).json({success:false,message:"Профиль не найден."});
    res.json({success:true,profile:result.rows[0]});
  } catch(error) { console.error("Panel profile error:",error); res.status(500).json({success:false,message:"Не удалось загрузить профиль."}); }
});

app.use("/api/admin", requireAdmin);

app.get("/owner", requireOwner, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "owner.html"));
});

async function writeOwnerAudit(req, action, entityType, entityId, details = {}) {
  try {
    await pool.query(`INSERT INTO rpm_owner_audit_logs (actor_user_id,action,entity_type,entity_id,details)
      VALUES ($1,$2,$3,$4,$5::jsonb)`, [req.userId || null, action, entityType, entityId == null ? null : String(entityId), JSON.stringify(details)]);
  } catch (error) {
    console.error("Owner audit log error:", error);
  }
}

function ownerDateRange(req) {
  const from = String(req.query.from || "").trim();
  const to = String(req.query.to || "").trim();
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z"));
  if ((from && !valid(from)) || (to && !valid(to)) || (from && to && from > to)) return null;
  const today = new Date().toISOString().slice(0,10);
  const defaultFrom = new Date(Date.now() - 183 * 86400000).toISOString().slice(0,10);
  return { from: from || defaultFrom, to: to || today };
}

// Владелец: партнёры, выплаты и финансовая статистика.
app.get("/api/owner/overview", requireOwner, async (req, res) => {
  const range = ownerDateRange(req);
  if (!range) return res.status(400).json({ success:false,message:"Некорректный период дат." });
  try {
    const [orders, commissions, partners, users, monthly] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE status='confirmed'),0)::bigint AS revenue,
                         COUNT(*) FILTER (WHERE status='confirmed')::int AS confirmed_orders,
                         COUNT(*) FILTER (WHERE status='pending')::int AS pending_orders
                  FROM rpm_orders
                  WHERE (status='confirmed' AND confirmed_at >= $1::date AND confirmed_at < ($2::date + INTERVAL '1 day'))
                     OR (status='pending' AND created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day'))`, [range.from,range.to]),
      pool.query(`SELECT COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status='pending'),0)::bigint AS due,
                         COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status='paid'),0)::bigint AS paid,
                         COALESCE(SUM(c.commission_amount),0)::bigint AS total
                  FROM rpm_commissions c JOIN rpm_orders o ON o.id=c.order_id
                  WHERE o.confirmed_at >= $1::date AND o.confirmed_at < ($2::date + INTERVAL '1 day')`, [range.from,range.to]),
      pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='active')::int AS active FROM rpm_partners`),
      pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='active')::int AS active FROM rpm_users WHERE role='customer'`),
      pool.query(`SELECT TO_CHAR(date_trunc('month', confirmed_at), 'YYYY-MM') AS month,
                         COALESCE(SUM(amount),0)::bigint AS revenue
                  FROM rpm_orders WHERE status='confirmed' AND confirmed_at >= $1::date
                    AND confirmed_at < ($2::date + INTERVAL '1 day')
                  GROUP BY date_trunc('month', confirmed_at) ORDER BY date_trunc('month', confirmed_at)`, [range.from,range.to])
    ]);
    const revenue = Number(orders.rows[0].revenue || 0);
    res.json({ success:true, range, summary:{
      revenue, due:Number(commissions.rows[0].due||0), paid:Number(commissions.rows[0].paid||0),
      net:revenue-Number(commissions.rows[0].total||0), confirmedOrders:orders.rows[0].confirmed_orders,
      pendingOrders:orders.rows[0].pending_orders, partners:partners.rows[0], customers:users.rows[0]
    }, monthly:monthly.rows });
  } catch (error) {
    console.error("Owner overview error:",error);
    res.status(500).json({success:false,message:"Не удалось загрузить финансовую статистику. Проверьте миграцию базы."});
  }
});

app.get("/api/owner/notifications", requireOwner, async (req,res)=>{
  try {
    const [orders, licenses] = await Promise.all([
      pool.query(`SELECT id,buyer_rp_nickname,amount,currency,created_at FROM rpm_orders WHERE status='pending' ORDER BY created_at DESC LIMIT 10`),
      pool.query(`SELECT u.username,u.rp_nickname,l.expires_at FROM rpm_licenses l JOIN rpm_users u ON u.id=l.user_id
        WHERE l.status='active' AND l.expires_at > NOW() AND l.expires_at <= NOW()+INTERVAL '7 days'
        ORDER BY l.expires_at ASC LIMIT 10`)
    ]);
    res.json({success:true, pendingOrders:orders.rows, expiringLicenses:licenses.rows});
  } catch(error) { console.error("Owner notifications error:",error); res.status(500).json({success:false,message:"Не удалось загрузить уведомления."}); }
});

app.get("/api/owner/audit", requireOwner, async (req,res)=>{
  try {
    const result=await pool.query(`SELECT id,actor_user_id,action,entity_type,entity_id,details,created_at
      FROM rpm_owner_audit_logs ORDER BY created_at DESC,id DESC LIMIT 100`);
    res.json({success:true,logs:result.rows});
  } catch(error) { console.error("Owner audit list error:",error); res.status(500).json({success:false,message:"Не удалось загрузить журнал действий."}); }
});

function csvCell(value) {
  let text=String(value ?? "");
  if (/^[=+@\-\t\r]/.test(text)) text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
app.get("/api/owner/export.csv", requireOwner, async (req,res)=>{
  const range=ownerDateRange(req);
  if(!range) return res.status(400).send("Некорректный период дат.");
  try {
    const result=await pool.query(`SELECT o.id,o.buyer_rp_nickname,o.plan_code,o.amount,o.currency,o.promo_code,o.status,o.created_at,o.confirmed_at,
      COALESCE(p.display_name,'') AS partner_name,COALESCE(c.commission_rate,0) AS commission_rate,
      COALESCE(c.commission_amount,0) AS commission_amount,COALESCE(c.status,'') AS commission_status
      FROM rpm_orders o LEFT JOIN rpm_commissions c ON c.order_id=o.id LEFT JOIN rpm_partners p ON p.id=c.partner_id
      WHERE o.created_at >= $1::date AND o.created_at < ($2::date + INTERVAL '1 day')
      ORDER BY o.created_at DESC,o.id DESC`,[range.from,range.to]);
    const rows=[['Order ID','Buyer RP nickname','Plan','Amount ($)','Currency','Promo code','Order status','Created at','Confirmed at','Partner','Rate %','Commission ($)','Commission status']];
    for(const r of result.rows) rows.push([r.id,r.buyer_rp_nickname,r.plan_code,r.amount,r.currency,r.promo_code,r.status,r.created_at,r.confirmed_at,r.partner_name,r.commission_rate,r.commission_amount,r.commission_status]);
    const csv='\uFEFF'+rows.map(row=>row.map(csvCell).join(';')).join('\r\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="rpm-finance-${range.from}-${range.to}.csv"`);
    res.send(csv);
  } catch(error) { console.error("Owner CSV export error:",error); res.status(500).send("Не удалось экспортировать отчёт."); }
});
app.get("/api/owner/partners", requireOwner, async (req, res) => {
  const range=ownerDateRange(req);
  if(!range) return res.status(400).json({success:false,message:"Некорректный период дат."});
  try {
    const result = await pool.query(`
      SELECT p.id, p.display_name, p.promo_code, p.bank_account, p.commission_rate, p.status, p.created_at,
        COALESCE(SUM(c.commission_amount),0)::bigint AS accrued,
        COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status='pending'),0)::bigint AS due,
        COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status='paid'),0)::bigint AS paid,
        COUNT(c.id)::int AS conversions
      FROM rpm_partners p LEFT JOIN rpm_commissions c ON c.partner_id=p.id
        AND c.created_at >= $1::date AND c.created_at < ($2::date + INTERVAL '1 day')
      GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC`,[range.from,range.to]);
    res.json({ success: true, partners: result.rows });
  } catch (error) {
    console.error("Owner partners error:", error);
    res.status(500).json({ success: false, message: "Не удалось загрузить партнёров. Проверьте миграцию базы." });
  }
});

app.post("/api/owner/partners", requireOwner, async (req, res) => {
  const displayName = String(req.body?.display_name || "").trim().slice(0, 80);
  const promoCode = String(req.body?.promo_code || "").trim().toUpperCase();
  const bankAccount = String(req.body?.bank_account || "").trim().slice(0, 100);
  const rate = Number(req.body?.commission_rate);
  if (!displayName || !/^[A-Z0-9_-]{2,32}$/.test(promoCode) || !bankAccount || !Number.isFinite(rate) || rate <= 0 || rate > 100) {
    return res.status(400).json({ success: false, message: "Проверьте имя, промокод, игровой банковский счёт и процент (0–100)." });
  }
  try {
    const duplicate = await pool.query("SELECT id FROM rpm_partners WHERE UPPER(promo_code)=UPPER($1) LIMIT 1", [promoCode]);
    if (duplicate.rowCount) return res.status(409).json({ success: false, message: "Такой промокод уже существует." });
    const result = await pool.query(`INSERT INTO rpm_partners (display_name,promo_code,bank_account,commission_rate,status)
      VALUES ($1,$2,$3,$4,'active') RETURNING id,display_name,promo_code,bank_account,commission_rate,status,created_at`,
      [displayName,promoCode,bankAccount,rate]);
    await writeOwnerAudit(req,"partner_created","partner",result.rows[0].id,{promo_code:promoCode,commission_rate:rate});
    res.status(201).json({ success: true, partner: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ success: false, message: "Такой промокод уже существует." });
    console.error("Create partner error:", error);
    res.status(500).json({ success: false, message: "Не удалось добавить партнёра." });
  }
});

app.patch("/api/owner/partners/:id", requireOwner, async (req, res) => {
  const id=String(req.params.id||"");
  if(!/^\d+$/.test(id)) return res.status(400).json({success:false,message:"Некорректный ID партнёра."});
  const displayName=String(req.body?.display_name||"").trim().slice(0,80);
  const promoCode=String(req.body?.promo_code||"").trim().toUpperCase();
  const bankAccount=String(req.body?.bank_account||"").trim().slice(0,100);
  const rate=Number(req.body?.commission_rate);
  const status=String(req.body?.status||"active");
  if(!displayName||!/^[A-Z0-9_-]{2,32}$/.test(promoCode)||!bankAccount||!Number.isFinite(rate)||rate<=0||rate>100||!["active","inactive"].includes(status))
    return res.status(400).json({success:false,message:"Проверьте данные партнёра."});
  try {
    const duplicate=await pool.query("SELECT id FROM rpm_partners WHERE UPPER(promo_code)=UPPER($1) AND id<>$2 LIMIT 1",[promoCode,id]);
    if(duplicate.rowCount) return res.status(409).json({success:false,message:"Такой промокод уже используется."});
    const result=await pool.query(`UPDATE rpm_partners SET display_name=$2,promo_code=$3,bank_account=$4,commission_rate=$5,status=$6
      WHERE id=$1 RETURNING id,display_name,promo_code,bank_account,commission_rate,status`,[id,displayName,promoCode,bankAccount,rate,status]);
    if(!result.rowCount) return res.status(404).json({success:false,message:"Партнёр не найден."});
    await writeOwnerAudit(req,"partner_updated","partner",id,{promo_code:promoCode,commission_rate:rate,status});
    res.json({success:true,partner:result.rows[0]});
  } catch(error) { console.error("Update partner error:",error); res.status(500).json({success:false,message:"Не удалось обновить партнёра."}); }
});

app.get("/api/owner/payouts", requireOwner, async (req, res) => {
  try {
    const result = await pool.query(`SELECT x.id,x.partner_id,p.display_name,p.promo_code,x.bank_account,x.amount,x.paid_at,x.note
      FROM rpm_partner_payouts x JOIN rpm_partners p ON p.id=x.partner_id
      ORDER BY x.paid_at DESC,x.id DESC LIMIT 200`);
    res.json({ success: true, payouts: result.rows });
  } catch (error) {
    console.error("Owner payouts error:", error);
    res.status(500).json({ success: false, message: "Не удалось загрузить историю выплат." });
  }
});

app.post("/api/owner/partners/:id/pay", requireOwner, async (req, res) => {
  const partnerId = String(req.params.id || "");
  if (!/^\d+$/.test(partnerId)) return res.status(400).json({ success: false, message: "Некорректный ID партнёра." });
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const partner = await db.query("SELECT id,bank_account FROM rpm_partners WHERE id=$1 FOR UPDATE", [partnerId]);
    if (!partner.rowCount) { await db.query("ROLLBACK"); return res.status(404).json({ success:false,message:"Партнёр не найден." }); }
    const due = await db.query("SELECT id,commission_amount FROM rpm_commissions WHERE partner_id=$1 AND status='pending' FOR UPDATE", [partnerId]);
    const amount = due.rows.reduce((sum,row)=>sum + Number(row.commission_amount || 0),0);
    if (!Number.isSafeInteger(amount) || amount <= 0) { await db.query("ROLLBACK"); return res.status(409).json({ success:false,message:"Нет начислений, ожидающих выплаты." }); }
    await db.query(`INSERT INTO rpm_partner_payouts (partner_id,amount,bank_account,paid_at,note,created_by)
      VALUES ($1,$2,$3,NOW(),$4,$5)`, [partnerId,amount,partner.rows[0].bank_account,String(req.body?.note || "Ручная выплата").slice(0,250),String(req.userId)]);
    const commissionIds = due.rows.map(row => row.id);
    await db.query("UPDATE rpm_commissions SET status='paid',paid_at=NOW() WHERE id = ANY($1::bigint[]) AND status='pending'", [commissionIds]);
    await db.query("COMMIT");
    await writeOwnerAudit(req,"partner_paid","partner",partnerId,{amount,bank_account:partner.rows[0].bank_account,commission_ids:commissionIds});
    res.json({ success:true, amount, message:"Выплата записана в историю." });
  } catch (error) {
    await db.query("ROLLBACK").catch(()=>{});
    console.error("Partner payout error:", error);
    res.status(500).json({ success:false,message:"Не удалось записать выплату." });
  } finally { db.release(); }
});

app.get("/api/admin/permissions", (req, res) => {
  return res.json({ isOwner: req.isOwner === true, isAdmin: req.isAdmin === true });
});

app.get("/api/admin/customers", async (req, res) => {
  const search = String(req.query.search || "").trim().slice(0, 100);

  try {
    const result = await pool.query(
      `SELECT
         u.id,
         u.username,
         u.rp_nickname,
         u.status,
         u.created_at,
         l.plan_code,
         l.starts_at,
         l.expires_at,
         CASE
           WHEN l.id IS NOT NULL
            AND l.status = 'active'
            AND l.starts_at <= NOW()
            AND l.expires_at > NOW()
           THEN TRUE
           ELSE FALSE
         END AS license_active,
         COALESCE(d.active_devices, 0)::int AS active_devices
       FROM rpm_users u
       LEFT JOIN LATERAL (
         SELECT id, plan_code, starts_at, expires_at, status
         FROM rpm_licenses
         WHERE user_id = u.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) l ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS active_devices
         FROM rpm_devices
         WHERE user_id = u.id
           AND revoked_at IS NULL
       ) d ON TRUE
       WHERE
         $1 = ''
         OR u.username ILIKE '%' || $1 || '%'
         OR u.rp_nickname ILIKE '%' || $1 || '%'
       ORDER BY u.created_at DESC
       LIMIT 200`,
      [search]
    );

    res.json({
      success: true,
      customers: result.rows
    });
  } catch (error) {
    console.error("Admin customers error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load customers."
    });
  }
});
app.get("/api/admin/customers/:id", async (req, res) => {
  const customerId = String(req.params.id || "").trim();

  if (!/^\d+$/.test(customerId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid customer ID."
    });
  }

  try {
    const customerResult = await pool.query(
      `SELECT
         id,
         username,
         rp_nickname,
         status,
         created_at
       FROM rpm_users
       WHERE id = $1
       LIMIT 1`,
      [customerId]
    );

    if (customerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Customer not found."
      });
    }

    const [licensesResult, devicesResult, ordersResult] =
      await Promise.all([
        pool.query(
          `SELECT
             id,
             order_id,
             plan_code,
             starts_at,
             expires_at,
             status,
             created_at
           FROM rpm_licenses
           WHERE user_id = $1
           ORDER BY created_at DESC, id DESC`,
          [customerId]
        ),

        pool.query(
          `SELECT
             id,
             device_name,
             created_at,
             last_seen_at,
             revoked_at
           FROM rpm_devices
           WHERE user_id = $1
           ORDER BY created_at DESC, id DESC`,
          [customerId]
        ),

        req.isOwner
          ? pool.query(
              `SELECT
                 id,
                 plan_code,
                 duration_days,
                 amount,
                 currency,
                 status,
                 created_at,
                 confirmed_at
               FROM rpm_orders
               WHERE user_id = $1
               ORDER BY created_at DESC, id DESC`,
              [customerId]
            )
          : Promise.resolve({ rows: [] })
      ]);

    res.json({
      success: true,
      customer: customerResult.rows[0],
      licenses: licensesResult.rows,
      devices: devicesResult.rows,
      orders: ordersResult.rows
    });

  } catch (error) {
    console.error("Admin customer details error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to load customer details."
    });
  }
});
app.post("/api/admin/customers/:id/status", async (req, res) => {
  const customerId = String(req.params.id || "").trim();
  const status = String(req.body.status || "").trim();

  if (!/^\d+$/.test(customerId)) {
    return res.status(400).json({
      success: false,
      message: "Некорректный ID покупателя."
    });
  }

  if (!["active", "blocked"].includes(status)) {
    return res.status(400).json({
      success: false,
      message: "Недопустимый статус."
    });
  }

  try {
    const result = await pool.query(
      `UPDATE rpm_users
       SET status = $2
       WHERE id = $1
       RETURNING id, username, status`,
      [customerId, status]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Покупатель не найден."
      });
    }

    return res.json({
      success: true,
      customer: result.rows[0],
      message: status === "blocked"
        ? "Покупатель заблокирован."
        : "Покупатель разблокирован."
    });
  } catch (error) {
    console.error("Admin customer status error:", error);

    return res.status(500).json({
      success: false,
      message: "Не удалось изменить статус покупателя."
    });
  }
});
app.get("/api/admin/orders", async (req, res) => {
  if (!req.isOwner) {
    return res.status(403).json({ success: false, message: "Доступ запрещён." });
  }
  try {
    const result = await pool.query(
      `SELECT
         o.id,
         o.buyer_rp_nickname,
         o.plan_code,
         o.duration_days,
         o.amount,
         o.currency,
         o.promo_code,
         o.status,
         o.created_at,
         o.confirmed_at,
         o.confirmed_by,
         u.username
       FROM rpm_orders o
       LEFT JOIN rpm_users u ON u.id = o.user_id
       ORDER BY
         CASE WHEN o.status = 'pending' THEN 0 ELSE 1 END,
         o.created_at DESC,
         o.id DESC
       LIMIT 200`
    );

    res.json({ success: true, orders: result.rows });
  } catch (error) {
    console.error("Admin orders list error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load orders."
    });
  }
});
app.post("/api/admin/orders", async (req, res) => {
  if (!req.isOwner) {
    return res.status(403).json({ success: false, message: "Доступ запрещён." });
  }
  try {
    let buyerRpNickname =
      typeof req.body?.buyer_rp_nickname === "string"
        ? req.body.buyer_rp_nickname.trim()
        : "";

    const planCode =
      typeof req.body?.plan_code === "string"
        ? req.body.plan_code.trim()
        : "";

    let promoCode =
      typeof req.body?.promo_code === "string"
        ? req.body.promo_code.trim().toUpperCase()
        : "";

    const plans = {
      "7_days": { durationDays: 7, amount: 300000 },
      "30_days": { durationDays: 30, amount: 2000000 },
      "90_days": { durationDays: 90, amount: 5000000 }
    };

    if (!buyerRpNickname || buyerRpNickname.length > 64) {
      return res.status(400).json({
        success: false,
        message: "Укажите RP-ник длиной от 1 до 64 символов."
      });
    }

    const plan = plans[planCode];

    if (!plan) {
      return res.status(400).json({
        success: false,
        message: "Неизвестный тариф."
      });
    }

    let linkedUserId = null;

    const userResult = await pool.query(
      `SELECT u.id, u.rp_nickname, u.status,
              r.promo_code AS referral_promo_code
       FROM rpm_users u
       LEFT JOIN rpm_referrals r ON r.user_id = u.id
       WHERE LOWER(TRIM(u.rp_nickname)) = LOWER(TRIM($1))
       ORDER BY u.id
       LIMIT 2`,
      [buyerRpNickname]
    );

    if (userResult.rowCount > 1) {
      return res.status(409).json({
        success: false,
        message: "Найдено несколько аккаунтов с этим RP-ником. Заказ не создан."
      });
    }

    if (userResult.rowCount === 1) {
      const existingUser = userResult.rows[0];

      if (existingUser.status !== "active") {
        return res.status(400).json({
          success: false,
          message: "Аккаунт клиента заблокирован или недоступен."
        });
      }

      linkedUserId = existingUser.id;
      buyerRpNickname = existingUser.rp_nickname;

      const originalPromoCode = existingUser.referral_promo_code || "";

      if (
        promoCode &&
        promoCode.toUpperCase() !== originalPromoCode.toUpperCase()
      ) {
        return res.status(400).json({
          success: false,
          message: "Нельзя изменить партнёрскую привязку существующего клиента."
        });
      }

      promoCode = originalPromoCode;
    } else if (promoCode) {
      const partner = await pool.query(
        `SELECT id FROM rpm_partners
         WHERE promo_code = $1 AND status = 'active'
         LIMIT 1`,
        [promoCode]
      );

      if (partner.rowCount === 0) {
        return res.status(400).json({
          success: false,
          message: "Промокод не найден или неактивен."
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO rpm_orders (
         user_id,
         buyer_rp_nickname,
         plan_code,
         duration_days,
         amount,
         currency,
         promo_code,
         status
       )
       VALUES ($1, $2, $3, $4, $5, 'RP', $6, 'pending')
       RETURNING id, user_id, buyer_rp_nickname, plan_code,
                 duration_days, amount, currency,
                 promo_code, status, created_at`,
      [
        linkedUserId,
        buyerRpNickname,
        planCode,
        plan.durationDays,
        plan.amount,
        promoCode || null
      ]
    );

    res.status(201).json({
      success: true,
      order: result.rows[0]
    });
  } catch (error) {
    console.error("Admin create order error:", error);
    res.status(500).json({
      success: false,
      message: "Не удалось создать заказ."
    });
  }
});
app.post("/api/admin/orders/:id/confirm", async (req, res) => {
  if (!req.isOwner) {
    return res.status(403).json({ success: false, message: "Доступ запрещён." });
  }
  const orderId = Number(req.params.id);

  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Некорректный номер заказа."
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    const orderResult = await client.query(
      `SELECT id, user_id, amount, promo_code, plan_code,
              duration_days, status
       FROM rpm_orders
       WHERE id = $1
       FOR UPDATE`,
      [orderId]
    );

    if (orderResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Заказ не найден."
      });
    }

    const order = orderResult.rows[0];

    if (order.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Заказ уже обработан."
      });
    }

    let inviteCode = null;
    let license = null;
    let commission = null;

    // Новый клиент: создаём приглашение на регистрацию.
    if (order.user_id === null) {
      inviteCode = randomBytes(16).toString("hex");

      const inviteHash = createHash("sha256")
        .update(inviteCode)
        .digest("hex");

      await client.query(
        `INSERT INTO rpm_invites (
           code_hash,
           order_id,
           expires_at,
           status
         )
         VALUES (
           $1,
           $2,
           NOW() + INTERVAL '24 hours',
           'active'
         )`,
        [inviteHash, orderId]
      );
    } else {
      // Существующий клиент: блокируем аккаунт,
      // чтобы параллельные продления не пересекались.
      const userResult = await client.query(
        `SELECT id, status
         FROM rpm_users
         WHERE id = $1
         FOR UPDATE`,
        [order.user_id]
      );

      if (
        userResult.rowCount === 0 ||
        userResult.rows[0].status !== "active"
      ) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          message: "Аккаунт клиента недоступен. Заказ не подтверждён."
        });
      }

      // Продление начинается с окончания действующей лицензии
      // либо с текущего времени, если действующей лицензии нет.
      const startResult = await client.query(
        `SELECT COALESCE(MAX(expires_at), NOW()) AS starts_at
         FROM rpm_licenses
         WHERE user_id = $1
           AND status = 'active'
           AND expires_at > NOW()`,
        [order.user_id]
      );

      const startsAt = startResult.rows[0].starts_at;

      const licenseResult = await client.query(
        `INSERT INTO rpm_licenses (
           user_id,
           order_id,
           plan_code,
           starts_at,
           expires_at,
           status
         )
         VALUES (
           $1,
           $2,
           $3,
           $4,
           $4::timestamptz + ($5 * INTERVAL '1 day'),
           'active'
         )
         RETURNING id, starts_at, expires_at, plan_code`,
        [
          order.user_id,
          orderId,
          order.plan_code,
          startsAt,
          order.duration_days
        ]
      );

      license = licenseResult.rows[0];

      await client.query(
        `INSERT INTO rpm_license_logs (
           user_id,
           license_id,
           actor_type,
           actor_id,
           action,
           details
         )
         VALUES ($1, $2, 'admin', $3, 'license_renewed', $4::jsonb)`,
        [
          order.user_id,
          license.id,
          process.env.APP_USER || "admin",
          JSON.stringify({
            orderId,
            planCode: order.plan_code,
            durationDays: order.duration_days
          })
        ]
      );
    }

    // Для существующего клиента партнёра определяем
    // исключительно по первоначальной записи referral.
    let partnerResult;

    if (order.user_id !== null) {
      partnerResult = await client.query(
        `SELECT p.id, p.commission_rate
         FROM rpm_referrals r
         JOIN rpm_partners p ON p.id = r.partner_id
         WHERE r.user_id = $1
         LIMIT 1`,
        [order.user_id]
      );
    } else if (order.promo_code) {
      partnerResult = await client.query(
        `SELECT id, commission_rate
         FROM rpm_partners
         WHERE promo_code = $1
         LIMIT 1`,
        [order.promo_code]
      );

      if (partnerResult.rowCount === 0) {
        throw new Error(
          "Partner for order promo code was not found."
        );
      }
    } else {
      partnerResult = { rowCount: 0, rows: [] };
    }

    if (partnerResult.rowCount > 0) {
      const partner = partnerResult.rows[0];
      const rate = Number(partner.commission_rate);

      const commissionAmount = Math.round(
        Number(order.amount) * rate / 100
      );

      await client.query(
        `INSERT INTO rpm_commissions (
           partner_id,
           order_id,
           order_amount,
           commission_rate,
           commission_amount,
           status
         )
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [
          partner.id,
          orderId,
          order.amount,
          rate,
          commissionAmount
        ]
      );

      commission = {
        rate,
        amount: commissionAmount
      };
    }

    await client.query(
      `UPDATE rpm_orders
       SET status = 'confirmed',
           confirmed_at = NOW(),
           confirmed_by = $2
       WHERE id = $1`,
      [orderId, process.env.APP_USER || "admin"]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: order.user_id === null
        ? "Заказ подтверждён."
        : "Заказ подтверждён, лицензия продлена.",
      invite_code: inviteCode,
      invite_expires_in_hours: inviteCode ? 24 : null,
      license,
      commission
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Order rollback error:", rollbackError);
      }
    }

    console.error("Admin confirm order error:", error);

    return res.status(500).json({
      success: false,
      message: "Не удалось подтвердить заказ."
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});
app.post("/api/admin/orders/:id/reject", async (req, res) => {
  if (!req.isOwner) {
    return res.status(403).json({
      success: false,
      message: "Доступ запрещён."
    });
  }

  const orderId = Number(req.params.id);

  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Некорректный номер заказа."
    });
  }

  try {
    const result = await pool.query(
      `UPDATE rpm_orders
       SET status = 'cancelled'
       WHERE id = $1 AND status = 'pending'
       RETURNING id, status`,
      [orderId]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({
        success: false,
        message: "Заказ не найден или уже обработан."
      });
    }

    return res.json({
      success: true,
      message: "Оплата отклонена. Заказ отменён.",
      order: result.rows[0]
    });
  } catch (error) {
    console.error("Admin reject order error:", error);
    return res.status(500).json({
      success: false,
      message: "Не удалось отклонить оплату."
    });
  }
});
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
  if (!req.isOwner) {
    return res.status(403).json({ error: "Доступ запрещён." });
  }

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

    const hasChildren = collectionKeys.some(key =>
      node[key] && typeof node[key] === "object"
    );

    const isArticle = Boolean(
        number &&
        !hasChildren &&
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

    if (!isArticle && ownTitle && hasChildren) {
      if (
          node.chapterNumber ||
          isChapterTitle(ownTitle)
      ) {
        nextContext.chapter = ownTitle;
        nextContext.section = "";
        nextContext.sectionNumber = "";
      } else {
        if (!nextContext.section) {
          nextContext.section = ownTitle;
        }

        if (number && !nextContext.sectionNumber) {
          nextContext.sectionNumber = number;
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
        sectionNumber: nextContext.sectionNumber || "",
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
      /(?:статья|статьи|ст\.?)\s*№?\s*\d+(?:\.\d+)*/gi
  ) || [];

  return matches.map(match => {
    const number = match.match(/\d+(?:\.\d+)*/);

    return number ? number[0] : null;
  }).filter(Boolean);
}

function detectReferenceDocument(text, allArticles) {
  const normalizedText = ` ${normalize(text)} `;

  const aliases = [
    { aliases: ["епк"], name: "Единый Процессуальный Кодекс" },
    { aliases: ["ук"], name: "Уголовный кодекс" },
    { aliases: ["ак"], name: "Административный кодекс" },
    { aliases: ["тк"], name: "Трудовой кодекс" },
    { aliases: ["ск"], name: "Социальный кодекс" }
  ];

  for (const item of aliases) {
    for (const alias of item.aliases) {
      if (normalizedText.includes(` ${alias} `)) {
        return item.name;
      }
    }
  }

  const documents = [
    ...new Set(allArticles.map(article => article.document).filter(Boolean))
  ].sort((a, b) => b.length - a.length);

  for (const document of documents) {
    const normalizedDocument = normalize(document);

    if (
      normalizedDocument.length >= 8 &&
      normalizedText.includes(` ${normalizedDocument} `)
    ) {
      return document;
    }
  }

  return "";
}

function extractChapterIdentifier(value) {
  const text = String(value || "");

  const explicit = text.match(
    /(?:глава|главы|гл\.?|раздел|часть)\s*([IVXLCDM]+|\d+)/i
  );

  if (explicit) return explicit[1].toUpperCase();

  const beginning = text.match(
    /^\s*([IVXLCDM]+|\d+)\s*[.)\-:]/i
  );

  return beginning ? beginning[1].toUpperCase() : "";
}

function auditReferences(referenceTexts, allArticles) {
  const results = [];
  const seen = new Set();

  for (const reference of referenceTexts || []) {
    const text = String(reference || "").trim();

    if (!text) continue;

    const key = normalize(text);

    if (seen.has(key)) continue;
    seen.add(key);

    const numbers = extractReferenceNumbers(text);
    const documentName = detectReferenceDocument(text, allArticles);
    const chapterIdentifier = extractChapterIdentifier(text);

    if (!numbers.length) {
      results.push({
        reference: text,
        status: "Не указан номер статьи",
        matches: [],
        explanation: "Для точной проверки необходимо указать номер статьи."
      });
      continue;
    }

    for (const number of numbers) {
      const numberMatches = allArticles.filter(article =>
        normalize(article.number) === normalize(number)
      );

      const documentMatches = documentName
        ? numberMatches.filter(article =>
            normalize(article.document) === normalize(documentName)
          )
        : numberMatches;

      const contextMatches = chapterIdentifier
        ? documentMatches.filter(article => {
            const actualChapter =
              extractChapterIdentifier(article.chapter) ||
              extractChapterIdentifier(article.section) ||
              extractChapterIdentifier(
                article.sectionNumber
                  ? `${article.sectionNumber}.`
                  : ""
              );

            return actualChapter === chapterIdentifier;
          })
        : documentMatches;

      let status;
      let explanation;

      if (!documentName) {
        status = "Недостаточно данных для подтверждения";
        explanation =
          "Номер статьи найден, но название нормативного документа не указано. Совпадение номера или главы само по себе не подтверждает юридическую ссылку.";
      } else if (documentMatches.length === 0) {
        status = "Документ не совпадает";
        explanation =
          `В документе «${documentName}» статья ${number} не найдена. Совпадения номера в других документах не считаются подтверждением.`;
      } else if (chapterIdentifier && contextMatches.length === 0) {
        status = "Глава не совпадает";
        explanation =
          `Номер статьи найден, но соответствие главе ${chapterIdentifier} не подтверждено.`;
      } else {
        status = "Подтверждено";
        explanation =
          "Указанный номер статьи совпадает с записью в базе по всем указанным реквизитам.";
      }

      const displayedMatches = contextMatches.length > 0
        ? contextMatches
        : documentName
          ? documentMatches
          : numberMatches;

      const otherDocumentMatches =
        documentName && documentMatches.length === 0
          ? numberMatches
          : [];

      const mapMatch = article => ({
        document: article.document,
        chapter: article.chapter,
        section: article.section,
        sectionNumber: article.sectionNumber || "",
        number: article.number,
        title: article.title
      });

      results.push({
        reference: text,
        number,
        document: documentName || "",
        chapter: chapterIdentifier || "",
        status,
        matches: displayedMatches.slice(0, 5).map(mapMatch),
        otherDocumentMatches: otherDocumentMatches
          .slice(0, 5)
          .map(mapMatch),
        explanation
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
    item.status === "Подтверждено"
  ).length;

  const unconfirmed = audit.length - confirmed;

  return {
    total: audit.length,
    confirmed,
    unconfirmed,
    status: unconfirmed > 0
      ? "Есть неподтверждённые ссылки"
      : audit.length
        ? "Все ссылки подтверждены"
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

RPM_FACT_DISCIPLINE_V3:
- Never invent witness statements, suspect statements, documents, recordings, actions, or evidence.
- Use only facts explicitly provided in the case materials.
- Keep confirmed facts, allegations, assumptions, and unknown information separate.
- Never describe an unprovided statement as an actual statement.
- If evidence is missing, identify exactly what is missing.
- Do not declare a violation proven when essential facts are unknown.
- Explain which conclusions are provisional and why.

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

RPM_FACT_DISCIPLINE_V3:
- Never invent witness statements, suspect statements, documents, recordings, actions, or evidence.
- Use only facts explicitly provided in the case materials.
- Keep confirmed facts, allegations, assumptions, and unknown information separate.
- Never describe an unprovided statement as an actual statement.
- If evidence is missing, identify exactly what is missing.
- Do not declare a violation proven when essential facts are unknown.
- Explain which conclusions are provisional and why.

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

function extractPlainAnswer(value, fallback) {
  let current = value;

  for (let i = 0; i < 4; i++) {
    if (current && typeof current === "object") {
      if (current.answer !== undefined) {
        current = current.answer;
        continue;
      }

      return JSON.stringify(current, null, 2);
    }

    if (typeof current !== "string") {
      return String(current || fallback);
    }

    const text = current.trim();

    if (!text) return fallback;

    if (text.startsWith("{") || text.startsWith("```")) {
      try {
        const parsed = parseJSON(text);

        if (parsed && typeof parsed === "object" &&
            parsed.answer !== undefined) {
          current = parsed.answer;
          continue;
        }
      } catch {
        // Оставляем исходный текст, если это не JSON.
      }
    }

    return text;
  }

  return typeof current === "string" ? current : fallback;
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
    answer: extractPlainAnswer(
        parsed.answer,
        "Анализ не получен."
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
    answer: extractPlainAnswer(
        parsed.answer,
        "Общий вывод не получен."
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

    const result = parseAIAnalysis(rawAnswer);

    return res.json({
      answer: result.answer
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
// ИСТОРИЯ ДЕЛ — POSTGRESQL
// =====================================================

app.get("/api/cases", async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(403).json({ error: "Не удалось определить аккаунт." });
    }

    const cases = await getCasesFromDB(req.userId);
    res.json(cases);
  } catch (error) {
    console.error("Load cases error:", error);
    res.status(500).json({ error: "Не удалось загрузить дела." });
  }
});

app.get("/api/case-backups", async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(403).json({ error: "Не удалось определить аккаунт." });
    }

    const result = await pool.query(
      `SELECT id, created_at, octet_length(cases::text) AS size
       FROM rpm_case_backups
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC`,
      [req.userId]
    );

    res.json(result.rows.map(row => ({
      filename: String(row.id),
      size: Number(row.size),
      createdAt: row.created_at
    })));
  } catch (error) {
    console.error("Load backups error:", error);
    res.status(500).json({ error: "Не удалось загрузить резервные копии." });
  }
});

app.post("/api/cases", async (req, res) => {
  if (!req.userId) {
    return res.status(403).json({ error: "Не удалось определить аккаунт." });
  }

  const id = String(req.body?.id || randomUUID()).trim();
  const title = String(req.body?.title || "Новое дело").trim().slice(0, 200);
  const data = req.body?.data && typeof req.body.data === "object" && !Array.isArray(req.body.data)
    ? req.body.data
    : {};
  const updatedAt = new Date().toISOString();

  if (!id || id.length > 200 || !title) {
    return res.status(400).json({ error: "Некорректные данные дела." });
  }

  let db;
  let transactionStarted = false;

  try {
    db = await pool.connect();
    await db.query("BEGIN");
    transactionStarted = true;

    await backupCasesDB(req.userId, db);

    const result = await db.query(
      `INSERT INTO rpm_cases (id, title, data, updated_at, user_id)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         data = EXCLUDED.data,
         updated_at = EXCLUDED.updated_at
       WHERE rpm_cases.user_id = EXCLUDED.user_id
       RETURNING id`,
      [id, title, JSON.stringify(data), updatedAt, req.userId]
    );

    if (!result.rowCount) {
      await db.query("ROLLBACK");
      transactionStarted = false;
      return res.status(409).json({
        error: "Дело с таким ID принадлежит другому аккаунту."
      });
    }

    await db.query("COMMIT");
    transactionStarted = false;
    res.json({ id, title, data, updatedAt });
  } catch (error) {
    if (transactionStarted && db) {
      await db.query("ROLLBACK").catch(() => {});
    }
    console.error("Save case error:", error);
    res.status(500).json({ error: "Не удалось сохранить дело." });
  } finally {
    if (db) db.release();
  }
});

app.post("/api/case-backups/restore", async (req, res) => {
  if (!req.userId) {
    return res.status(403).json({ error: "Не удалось определить аккаунт." });
  }

  const backupId = Number(req.body?.filename);
  if (!Number.isSafeInteger(backupId) || backupId <= 0) {
    return res.status(400).json({ error: "Некорректный номер резервной копии." });
  }

  let db;
  let transactionStarted = false;

  try {
    db = await pool.connect();
    await db.query("BEGIN");
    transactionStarted = true;

    const result = await db.query(
      `SELECT cases
       FROM rpm_case_backups
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [backupId, req.userId]
    );

    if (!result.rowCount) {
      await db.query("ROLLBACK");
      transactionStarted = false;
      return res.status(404).json({ error: "Резервная копия не найдена." });
    }

    const backupData = result.rows[0].cases;
    if (!Array.isArray(backupData)) {
      await db.query("ROLLBACK");
      transactionStarted = false;
      return res.status(400).json({ error: "Формат резервной копии повреждён." });
    }

    await backupCasesDB(req.userId, db);
    await db.query(
      "DELETE FROM rpm_cases WHERE user_id = $1",
      [req.userId]
    );

    for (const item of backupData) {
      if (!item || !item.id) {
        throw new Error("В резервной копии найдено дело без ID.");
      }

      await db.query(
        `INSERT INTO rpm_cases (id, title, data, updated_at, user_id)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [
          String(item.id),
          String(item.title || "Без названия").slice(0, 200),
          JSON.stringify(item.data && typeof item.data === "object" ? item.data : {}),
          item.updatedAt || new Date().toISOString(),
          req.userId
        ]
      );
    }

    await db.query("COMMIT");
    transactionStarted = false;
    res.json({ success: true, restored: backupData.length });
  } catch (error) {
    if (transactionStarted && db) {
      await db.query("ROLLBACK").catch(() => {});
    }
    console.error("Restore backup error:", error);
    res.status(error.code === "23505" ? 409 : 500).json({
      error: error.code === "23505"
        ? "Восстановление остановлено: ID одного из дел уже занят другим аккаунтом."
        : "Не удалось восстановить резервную копию."
    });
  } finally {
    if (db) db.release();
  }
});

app.delete("/api/cases/:id", async (req, res) => {
  if (!req.userId) {
    return res.status(403).json({ error: "Не удалось определить аккаунт." });
  }

  let db;
  let transactionStarted = false;

  try {
    db = await pool.connect();
    await db.query("BEGIN");
    transactionStarted = true;

    await backupCasesDB(req.userId, db);

    const result = await db.query(
      `DELETE FROM rpm_cases
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [req.params.id, req.userId]
    );

    if (!result.rowCount) {
      await db.query("ROLLBACK");
      transactionStarted = false;
      return res.status(404).json({ error: "Дело не найдено." });
    }

    await db.query("COMMIT");
    transactionStarted = false;
    res.json({ success: true });
  } catch (error) {
    if (transactionStarted && db) {
      await db.query("ROLLBACK").catch(() => {});
    }
    console.error("Delete case error:", error);
    res.status(500).json({ error: "Не удалось удалить дело." });
  } finally {
    if (db) db.release();
  }
});

app.get("/api/admin/support/tickets", async (req, res) => {
  try {
    const status = String(req.query.status || "").trim();
    const params = [];
    let where = "";

    if (status && ["open", "waiting_customer", "closed"].includes(status)) {
      params.push(status);
      where = "WHERE t.status = $1";
    }

    const result = await pool.query(
      `SELECT
         t.id,
         t.user_id,
         t.subject,
         t.status,
         t.created_at,
         t.updated_at,
         t.last_message_at,
         u.username,
         u.rp_nickname,
         (
           SELECT m.message
           FROM rpm_support_messages m
           WHERE m.ticket_id = t.id
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT 1
         ) AS last_message,
         (
           SELECT COUNT(*)::int
           FROM rpm_support_messages m
           WHERE m.ticket_id = t.id
             AND m.sender_type = 'customer'
             AND m.read_at IS NULL
         ) AS unread_count
       FROM rpm_support_tickets t
       JOIN rpm_users u ON u.id = t.user_id
       ${where}
       ORDER BY
         CASE WHEN t.status = 'closed' THEN 1 ELSE 0 END,
         t.last_message_at DESC,
         t.id DESC`,
      params
    );

    res.json({ success: true, tickets: result.rows });
  } catch (error) {
    console.error("Admin support tickets error:", error);
    res.status(500).json({ error: "Не удалось загрузить обращения." });
  }
});

app.get("/api/admin/support/tickets/:id/messages", async (req, res) => {
  const ticketId = String(req.params.id);

  if (!/^[1-9]\d{0,18}$/.test(ticketId)) {
    return res.status(400).json({ error: "Некорректный ID обращения." });
  }

  try {
    const ticket = await pool.query(
      `SELECT
         t.id,
         t.user_id,
         t.subject,
         t.status,
         t.created_at,
         t.updated_at,
         u.username,
         u.rp_nickname
       FROM rpm_support_tickets t
       JOIN rpm_users u ON u.id = t.user_id
       WHERE t.id = $1`,
      [ticketId]
    );

    if (!ticket.rowCount) {
      return res.status(404).json({ error: "Обращение не найдено." });
    }

    await pool.query(
      `UPDATE rpm_support_messages
       SET read_at = NOW()
       WHERE ticket_id = $1
         AND sender_type = 'customer'
         AND read_at IS NULL`,
      [ticketId]
    );

    const messages = await pool.query(
      `SELECT id, sender_type, sender_label, message, created_at
       FROM rpm_support_messages
       WHERE ticket_id = $1
       ORDER BY created_at ASC, id ASC`,
      [ticketId]
    );

    res.json({
      success: true,
      ticket: ticket.rows[0],
      messages: messages.rows
    });
  } catch (error) {
    console.error("Admin support messages error:", error);
    res.status(500).json({ error: "Не удалось загрузить переписку." });
  }
});

app.post("/api/admin/support/tickets/:id/messages", async (req, res) => {
  const ticketId = String(req.params.id);
  const message = String(req.body?.message || "").trim();

  if (!/^[1-9]\d{0,18}$/.test(ticketId)) {
    return res.status(400).json({ error: "Некорректный ID обращения." });
  }

  if (!message || message.length > 3000) {
    return res.status(400).json({
      error: "Ответ должен содержать от 1 до 3000 символов."
    });
  }

  let db;

  try {
    db = await pool.connect();
    await db.query("BEGIN");

    const ticket = await db.query(
      `SELECT id
       FROM rpm_support_tickets
       WHERE id = $1
       FOR UPDATE`,
      [ticketId]
    );

    if (!ticket.rowCount) {
      await db.query("ROLLBACK");
      return res.status(404).json({ error: "Обращение не найдено." });
    }

    await db.query(
      `INSERT INTO rpm_support_messages
         (ticket_id, sender_type, sender_label, message)
       VALUES ($1, 'admin', 'Администрация', $2)`,
      [ticketId, message]
    );

    await db.query(
      `UPDATE rpm_support_tickets
       SET status = 'waiting_customer',
           closed_at = NULL,
           updated_at = NOW(),
           last_message_at = NOW()
       WHERE id = $1`,
      [ticketId]
    );

    await db.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    if (db) await db.query("ROLLBACK").catch(() => {});
    console.error("Admin support reply error:", error);
    res.status(500).json({ error: "Не удалось отправить ответ." });
  } finally {
    if (db) db.release();
  }
});

app.post("/api/admin/support/tickets/:id/status", async (req, res) => {
  const ticketId = String(req.params.id);
  const status = String(req.body?.status || "").trim();

  if (!/^[1-9]\d{0,18}$/.test(ticketId)) {
    return res.status(400).json({ error: "Некорректный ID обращения." });
  }

  if (!["open", "waiting_customer", "closed"].includes(status)) {
    return res.status(400).json({ error: "Некорректный статус." });
  }

  try {
    const result = await pool.query(
      `UPDATE rpm_support_tickets
       SET status = $2::varchar,
           closed_at = CASE WHEN $2::varchar = 'closed' THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, status, updated_at, closed_at`,
      [ticketId, status]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Обращение не найдено." });
    }

    res.json({ success: true, ticket: result.rows[0] });
  } catch (error) {
    console.error("Admin support status error:", error);
    res.status(500).json({ error: "Не удалось изменить статус." });
  }
});
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
    await pool.query("SELECT 1");
    console.log("Подключение к PostgreSQL успешно.");
  } catch (error) {
    console.error("Ошибка подключения к PostgreSQL:", error);
  }
});
