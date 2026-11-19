import bcrypt from "bcryptjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export default function registerCustomerAuth(app, pool) {
  const hashInvite = (code) =>
    createHash("sha256").update(code).digest("hex");


  const registerDevice = async (userId, req, res) => {
    let token = null;

    const cookieHeader = req.headers.cookie || "";
    const deviceCookie = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("rpm.device="));

    if (deviceCookie) {
      const candidate = deviceCookie.slice("rpm.device=".length);
      if (/^[a-f0-9]{64}$/.test(candidate)) {
        token = candidate;
      }
    }

    if (!token) {
      token = randomBytes(32).toString("hex");
    }

    let tokenHash = createHash("sha256").update(token).digest("hex");
    const db = await pool.connect();

    try {
      await db.query("BEGIN");
      await db.query(
        "SELECT pg_advisory_xact_lock($1::bigint)",
        [userId]
      );

      const existing = await db.query(
        `SELECT id, user_id, revoked_at
         FROM rpm_devices
         WHERE device_token_hash = $1
         FOR UPDATE`,
        [tokenHash]
      );

      if (
        existing.rowCount &&
        String(existing.rows[0].user_id) === String(userId) &&
        !existing.rows[0].revoked_at
      ) {
        const deviceId = existing.rows[0].id;

        await db.query(
          "UPDATE rpm_devices SET last_seen_at = NOW() WHERE id = $1",
          [deviceId]
        );

        await db.query("COMMIT");

        res.cookie("rpm.device", token, {
          httpOnly: true,
          secure: req.secure,
          sameSite: "lax",
          path: "/",
          maxAge: 365 * 24 * 60 * 60 * 1000
        });

        return { ok: true, deviceId };
      }

      if (existing.rowCount) {
        token = randomBytes(32).toString("hex");
        tokenHash = createHash("sha256").update(token).digest("hex");
      }

      const countResult = await db.query(
        `SELECT COUNT(*)::int AS count
         FROM rpm_devices
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );

      if (countResult.rows[0].count >= 2) {
        await db.query("ROLLBACK");
        return { ok: false };
      }

      const userAgent = String(req.headers["user-agent"] || "Unknown device")
        .slice(0, 120);

      const inserted = await db.query(
        `INSERT INTO rpm_devices
           (user_id, device_token_hash, device_name)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [userId, tokenHash, userAgent]
      );

      await db.query("COMMIT");

      res.cookie("rpm.device", token, {
        httpOnly: true,
        secure: req.secure,
        sameSite: "lax",
        path: "/",
        maxAge: 365 * 24 * 60 * 60 * 1000
      });

      return { ok: true, deviceId: inserted.rows[0].id };
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  };

  const saveSession = (req, res, user, deviceId) => {
    req.session.regenerate((error) => {
      if (error) {
        console.error("Session regeneration failed:", error);
        return res.status(500).json({ error: "Не удалось создать сессию. Попробуйте войти." });
      }

      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role || "customer";
      req.session.deviceId = String(deviceId);

      req.session.save((saveError) => {
        if (saveError) {
          console.error("Session save failed:", saveError);
          return res.status(500).json({ error: "Не удалось сохранить сессию. Попробуйте войти." });
        }

        res.json({ success: true });
      });
    });
  };

  app.post("/api/customer/register", async (req, res) => {
    const inviteCode = String(req.body?.inviteCode || "").trim();
    const username = String(req.body?.username || "").trim().toLowerCase();
    const rpNickname = String(req.body?.rpNickname || "").trim();
    const password = String(req.body?.password || "");

    if (!inviteCode || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username) ||
        !rpNickname || rpNickname.length > 64 ||
        password.length < 12 || Buffer.byteLength(password, "utf8") > 72) {
      return res.status(400).json({ error: "Проверьте введённые данные. Пароль: от 12 символов, максимум 72 байта." });
    }

    const db = await pool.connect();

    try {
      await db.query("BEGIN");

      const inviteResult = await db.query(
        `SELECT id, order_id
         FROM rpm_invites
         WHERE code_hash = $1
           AND status = 'active'
           AND expires_at > NOW()
         FOR UPDATE`,
        [hashInvite(inviteCode)]
      );

      if (!inviteResult.rowCount) {
        await db.query("ROLLBACK");
        return res.status(400).json({ error: "Код приглашения недействителен или истёк." });
      }

      const invite = inviteResult.rows[0];

      if (!invite.order_id) {
        await db.query("ROLLBACK");
        return res.status(400).json({ error: "Приглашение не связано с подтверждённым заказом." });
      }

      const orderResult = await db.query(
        `SELECT id, plan_code, duration_days, status, promo_code
         FROM rpm_orders
         WHERE id = $1
         FOR UPDATE`,
        [invite.order_id]
      );

      if (!orderResult.rowCount || orderResult.rows[0].status !== "confirmed") {
        await db.query("ROLLBACK");
        return res.status(400).json({ error: "Заказ ещё не подтверждён." });
      }

      const order = orderResult.rows[0];
      const passwordHash = await bcrypt.hash(password, 12);

      const userResult = await db.query(
        `INSERT INTO rpm_users (username, password_hash, rp_nickname)
         VALUES ($1, $2, $3)
         RETURNING id, username`,
        [username, passwordHash, rpNickname]
      );

      const user = userResult.rows[0];

      const usedInvite = await db.query(
        `UPDATE rpm_invites
         SET status = 'used', used_at = NOW()
         WHERE id = $1 AND status = 'active'`,
        [invite.id]
      );

      if (!usedInvite.rowCount) {
        throw new Error("INVITE_ALREADY_USED");
      }

      await db.query(
        "UPDATE rpm_orders SET user_id = $1 WHERE id = $2",
        [user.id, order.id]
      );

      const licenseResult = await db.query(
        `INSERT INTO rpm_licenses
           (user_id, order_id, plan_code, starts_at, expires_at, status)
         VALUES
           ($1, $2, $3, NOW(), NOW() + ($4 * INTERVAL '1 day'), 'active')
         RETURNING id`,
        [user.id, order.id, order.plan_code, order.duration_days]
      );

      if (order.promo_code) {
        await db.query(
          `INSERT INTO rpm_referrals (user_id, partner_id, promo_code)
           SELECT $1, id, promo_code
           FROM rpm_partners
           WHERE promo_code = $2
           ON CONFLICT (user_id) DO NOTHING`,
          [user.id, order.promo_code]
        );
      }

      await db.query(
        `INSERT INTO rpm_license_logs
           (user_id, license_id, actor_type, actor_id, action, details)
         VALUES ($1, $2, 'user', $3, 'license_activated', $4::jsonb)`,
        [
          user.id,
          licenseResult.rows[0].id,
          username,
          JSON.stringify({ orderId: order.id, planCode: order.plan_code })
        ]
      );

      await db.query("COMMIT");

      const device = await registerDevice(user.id, req, res);

      if (!device.ok) {
        return res.status(403).json({
          error: "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043e\u0432\u0430\u0442\u044c \u0443\u0441\u0442\u0440\u043e\u0439\u0441\u0442\u0432\u043e."
        });
      }

      saveSession(req, res, user, device.deviceId);
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});

      if (error.code === "23505") {
        return res.status(409).json({ error: "Это имя пользователя уже занято." });
      }

      if (error.message === "INVITE_ALREADY_USED") {
        return res.status(409).json({ error: "Код приглашения уже использован." });
      }

      console.error("Customer registration error:", error);
      return res.status(500).json({ error: "Ошибка регистрации. Попробуйте позже." });
    } finally {
      db.release();
    }
  });

  app.post("/api/customer/login", async (req, res) => {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!username || !password || Buffer.byteLength(password, "utf8") > 72) {
      return res.status(400).json({ error: "Введите имя пользователя и пароль." });
    }

    try {
      const result = await pool.query(
        `SELECT u.id, u.username, u.password_hash, u.status, u.role,
                EXISTS (
                  SELECT 1 FROM rpm_licenses l
                  WHERE l.user_id = u.id
                    AND l.status = 'active'
                    AND l.expires_at > NOW()
                ) AS has_license
         FROM rpm_users u
         WHERE u.username = $1`,
        [username]
      );

      if (!result.rowCount) {
        return res.status(401).json({ error: "Неверное имя пользователя или пароль." });
      }

      const user = result.rows[0];
      const passwordMatches = await bcrypt.compare(password, user.password_hash);

      if (!passwordMatches || user.status !== "active" || user.role !== "customer" || user.has_license !== true) {
        return res.status(401).json({ error: "Неверное имя пользователя или пароль." });
      }


      const device = await registerDevice(user.id, req, res);

      if (!device.ok) {
        return res.status(403).json({
          error: "\u0414\u043e\u0441\u0442\u0438\u0433\u043d\u0443\u0442 \u043b\u0438\u043c\u0438\u0442 \u0434\u0432\u0443\u0445 \u0443\u0441\u0442\u0440\u043e\u0439\u0441\u0442\u0432. \u041e\u0431\u0440\u0430\u0442\u0438\u0442\u0435\u0441\u044c \u043a \u0430\u0434\u043c\u0438\u043d\u0438\u0441\u0442\u0440\u0430\u0442\u043e\u0440\u0443 \u0434\u043b\u044f \u043e\u0442\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u044f \u0441\u0442\u0430\u0440\u043e\u0433\u043e \u0443\u0441\u0442\u0440\u043e\u0439\u0441\u0442\u0432\u0430."
        });
      }

      saveSession(req, res, user, device.deviceId);
    } catch (error) {
      console.error("Customer login error:", error);
      return res.status(500).json({ error: "Ошибка входа. Попробуйте позже." });
    }
  });

  app.post("/api/customer/logout", (req, res) => {
    req.session.destroy((error) => {
      if (error) {
        console.error("Customer logout error:", error);
        return res.status(500).json({ error: "Не удалось завершить сессию." });
      }

      res.clearCookie("rpm.sid", {
        httpOnly: true,
        secure: "auto",
        sameSite: "lax"
      });

      res.clearCookie("rpm.device", {
        httpOnly: true,
        secure: req.secure,
        sameSite: "lax",
        path: "/"
      });

      res.json({ success: true });
    });
  });

  // =====================================================
  // ?????????? ????????????
  // =====================================================

  app.get("/api/customer/devices", async (req, res) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: "????????? ????." });
    }

    try {
      if (!(await checkCustomerDevice(req, res))) return;
      const result = await pool.query(
        `SELECT id, device_name, created_at, last_seen_at,
                (device_token_hash = $2) AS current_device
         FROM rpm_devices
         WHERE user_id = $1
           AND revoked_at IS NULL
         ORDER BY last_seen_at DESC`,
        [
          req.session.userId,
          (() => {
            const cookieHeader = req.headers.cookie || "";
            const deviceCookie = cookieHeader
              .split(";")
              .map((part) => part.trim())
              .find((part) => part.startsWith("rpm.device="));

            const token = deviceCookie
              ? deviceCookie.slice("rpm.device=".length)
              : "";

            return /^[a-f0-9]{64}$/.test(token)
              ? createHash("sha256").update(token).digest("hex")
              : "";
          })()
        ]
      );

      res.json({ success: true, devices: result.rows });
    } catch (error) {
      console.error("Customer devices lookup error:", error);
      res.status(500).json({ error: "?? ??????? ????????? ??????????." });
    }
  });

  app.delete("/api/customer/devices/:id", async (req, res) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: "????????? ????." });
    }

    const deviceId = Number(req.params.id);

    if (!Number.isSafeInteger(deviceId) || deviceId <= 0) {
      return res.status(400).json({ error: "???????????? ID ??????????." });
    }

    try {
      if (!(await checkCustomerDevice(req, res))) return;
      const result = await pool.query(
        `UPDATE rpm_devices
         SET revoked_at = NOW()
         WHERE id = $1
           AND user_id = $2
           AND revoked_at IS NULL
         RETURNING id`,
        [deviceId, req.session.userId]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          error: "?????????? ?? ??????? ??? ??? ?????????."
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Customer device revoke error:", error);
      res.status(500).json({ error: "?? ??????? ????????? ??????????." });
    }
  });

  app.get("/api/customer/me", async (req, res) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: "Требуется вход." });
    }

    try {
      if (!(await checkCustomerDevice(req, res))) return;
      const result = await pool.query(
        `SELECT u.id, u.username, u.rp_nickname, u.role,
                COALESCE(u.display_name, u.rp_nickname) AS display_name,
                u.avatar_data, COALESCE(u.theme, 'quantum-purple') AS theme,
                l.plan_code, l.starts_at, l.expires_at,
                (
                  u.role = 'admin'
                  OR COALESCE(
                    l.status = 'active' AND l.expires_at > NOW(),
                    false
                  )
                ) AS has_license
         FROM rpm_users u
         LEFT JOIN LATERAL (
           SELECT plan_code, starts_at, expires_at, status
           FROM rpm_licenses
           WHERE user_id = u.id
           ORDER BY expires_at DESC
           LIMIT 1
         ) l ON true
         WHERE u.id = $1
           AND u.status = 'active'`,
        [req.session.userId]
      );

      if (!result.rowCount) {
        req.session.destroy(() => {});
        return res.status(403).json({
          error: "Аккаунт заблокирован или недоступен."
        });
      }

      res.json({
        success: true,
        user: result.rows[0]
      });
    } catch (error) {
      console.error("Customer account lookup error:", error);
      res.status(500).json({
        error: "Не удалось загрузить аккаунт."
      });
    }
  });
  app.post("/api/customer/renewal-orders", async (req, res) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: "Требуется вход." });
    }

    try {
      if (!(await checkCustomerDevice(req, res))) return;
    } catch (error) {
      console.error("Customer renewal device check error:", error);
      return res.status(500).json({
        error: "Не удалось проверить устройство."
      });
    }

    const plans = {
      "7_days": { durationDays: 7, amount: 300000 },
      "30_days": { durationDays: 30, amount: 2000000 },
      "90_days": { durationDays: 90, amount: 5000000 }
    };

    const planCode = String(req.body?.plan_code || "").trim();
    const plan = plans[planCode];

    if (!plan) {
      return res.status(400).json({
        error: "Выбран неизвестный тариф."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const userResult = await client.query(
        `SELECT id, rp_nickname
         FROM rpm_users
         WHERE id = $1 AND status = 'active'
         FOR UPDATE`,
        [req.session.userId]
      );

      if (!userResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(403).json({
          error: "Аккаунт заблокирован или недоступен."
        });
      }

      const pendingResult = await client.query(
        `SELECT id
         FROM rpm_orders
         WHERE user_id = $1 AND status = 'pending'
         LIMIT 1`,
        [req.session.userId]
      );

      if (pendingResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "У тебя уже есть заказ, ожидающий подтверждения оплаты.",
          order_id: pendingResult.rows[0].id
        });
      }

      const orderResult = await client.query(
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
         VALUES ($1, $2, $3, $4, $5, 'RP', NULL, 'pending')
         RETURNING id, plan_code, duration_days, amount, status, created_at`,
        [
          req.session.userId,
          userResult.rows[0].rp_nickname,
          planCode,
          plan.durationDays,
          plan.amount
        ]
      );

      await client.query("COMMIT");

      return res.status(201).json({
        success: true,
        message: "Заказ создан. Ожидает подтверждения оплаты администрацией.",
        order: orderResult.rows[0]
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("Customer renewal order error:", error);

      return res.status(500).json({
        error: "Не удалось создать заказ на продление."
      });
    } finally {
      client.release();
    }
  });
  const checkCustomerDevice = async (req, res) => {
    const userId = req.session?.userId;
    const deviceId = req.session?.deviceId;

    if (!userId || !deviceId) {
      res.status(401).json({ error: "Требуется вход." });
      return false;
    }

    const cookieHeader = req.headers.cookie || "";
    const deviceCookie = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("rpm.device="));

    const token = deviceCookie
      ? deviceCookie.slice("rpm.device=".length)
      : "";

    if (!/^[a-f0-9]{64}$/.test(token)) {
      req.session.destroy(() => {});
      res.clearCookie("rpm.sid", {
        httpOnly: true,
        secure: "auto",
        sameSite: "lax"
      });
      res.clearCookie("rpm.device", {
        httpOnly: true,
        secure: req.secure,
        sameSite: "lax",
        path: "/"
      });
      res.status(401).json({ error: "Устройство не подтверждено." });
      return false;
    }

    const tokenHash = createHash("sha256").update(token).digest("hex");

    const result = await pool.query(
      `UPDATE rpm_devices d
       SET last_seen_at = NOW()
       FROM rpm_users u
       WHERE d.id = $1
         AND d.user_id = $2
         AND d.device_token_hash = $3
         AND d.revoked_at IS NULL
         AND u.id = d.user_id
         AND u.status = 'active'
       AND u.role = 'customer'
       AND EXISTS (
         SELECT 1
         FROM rpm_licenses l
         WHERE l.user_id = u.id
           AND l.status = 'active'
           AND l.expires_at > NOW()
       )
       RETURNING d.id`,
      [deviceId, userId, tokenHash]
    );

    if (!result.rowCount) {
      req.session.destroy(() => {});
      res.clearCookie("rpm.sid", {
        httpOnly: true,
        secure: "auto",
        sameSite: "lax"
      });
      res.clearCookie("rpm.device", {
        httpOnly: true,
        secure: req.secure,
        sameSite: "lax",
        path: "/"
      });
      res.status(401).json({
        error: "Сессия устройства недействительна. Войдите снова."
      });
      return false;
    }

    return true;
  };

  app.get("/api/customer/profile", async (req, res) => {
    try {
      if (!(await checkCustomerDevice(req, res))) return;
      const result = await pool.query(
        `SELECT id, username, rp_nickname, COALESCE(display_name,rp_nickname) AS display_name,
                avatar_data, COALESCE(theme,'quantum-purple') AS theme
         FROM rpm_users WHERE id=$1 AND status='active'`, [req.session.userId]
      );
      if (!result.rowCount) return res.status(404).json({ success:false,error:"Профиль не найден." });
      res.json({ success:true, profile:result.rows[0] });
    } catch (error) {
      console.error("Customer profile load error:", error);
      res.status(500).json({ success:false,error:"Не удалось загрузить профиль." });
    }
  });

  app.put("/api/customer/profile", async (req, res) => {
    try {
      if (!(await checkCustomerDevice(req, res))) return;
      const username = String(req.body?.username || "").trim().toLowerCase();
      const displayName = String(req.body?.display_name || "").trim();
      const rpNickname = String(req.body?.rp_nickname || "").trim();
      const avatarData = req.body?.avatar_data === null ? null : String(req.body?.avatar_data || "");
      const theme = String(req.body?.theme || "quantum-purple");
      const allowedThemes = ["quantum-purple","minimal-light","graphite","cyber-blue"];
      if (!/^[a-z0-9_.-]{3,32}$/.test(username) || !displayName || displayName.length > 64 || !rpNickname || rpNickname.length > 64 || !allowedThemes.includes(theme)) {
        return res.status(400).json({ success:false,error:"Проверьте логин, имя, RP-имя и тему оформления." });
      }
      if (avatarData && (!/^data:image\/(png|jpeg|webp);base64,/.test(avatarData) || avatarData.length > 700000)) {
        return res.status(400).json({ success:false,error:"Аватар должен быть PNG, JPG или WebP размером до 500 КБ." });
      }
      const current = await pool.query("SELECT username,role FROM rpm_users WHERE id=$1 AND status='active'", [req.session.userId]);
      if (!current.rowCount) return res.status(404).json({ success:false,error:"Аккаунт не найден." });
      if (current.rows[0].role === "admin" && username !== String(current.rows[0].username).toLowerCase()) {
        return res.status(400).json({ success:false,error:"Логин администратора нельзя менять из личного кабинета." });
      }
      const result = await pool.query(
        `UPDATE rpm_users SET username=$1, display_name=$2, rp_nickname=$3,
           avatar_data=$4, theme=$5
         WHERE id=$6 AND status='active'
         RETURNING id,username,rp_nickname,display_name,avatar_data,theme`,
        [username,displayName,rpNickname,avatarData || null,theme,req.session.userId]
      );
      if (!result.rowCount) return res.status(404).json({ success:false,error:"Аккаунт не найден." });
      req.session.username = username;
      req.session.rpNickname = rpNickname;
      req.session.save((saveError) => {
        if (saveError) return res.status(500).json({ success:false,error:"Не удалось сохранить сессию." });
        res.json({ success:true,profile:result.rows[0] });
      });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ success:false,error:"Этот логин уже занят." });
      console.error("Customer profile update error:", error);
      res.status(500).json({ success:false,error:"Не удалось сохранить профиль." });
    }
  });

  app.post("/api/customer/password", async (req, res) => {
    try {
      if (!(await checkCustomerDevice(req, res))) return;
      const currentPassword = String(req.body?.current_password || "");
      const newPassword = String(req.body?.new_password || "");
      if (newPassword.length < 12 || Buffer.byteLength(newPassword,"utf8") > 72) {
        return res.status(400).json({ success:false,error:"Новый пароль должен содержать от 12 символов (до 72 байт)." });
      }
      const user = await pool.query("SELECT password_hash FROM rpm_users WHERE id=$1",[req.session.userId]);
      if (!user.rowCount || !(await bcrypt.compare(currentPassword,user.rows[0].password_hash))) {
        return res.status(400).json({ success:false,error:"Текущий пароль указан неверно." });
      }
      const hash = await bcrypt.hash(newPassword,12);
      await pool.query("UPDATE rpm_users SET password_hash=$1 WHERE id=$2",[hash,req.session.userId]);
      res.json({ success:true,message:"Пароль изменён." });
    } catch (error) {
      console.error("Customer password update error:",error);
      res.status(500).json({ success:false,error:"Не удалось изменить пароль." });
    }
  });

  const getCustomerCases = async (userId, db = pool) => {
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
  };

  const backupCustomerCases = async (userId, db = pool) => {
    const cases = await getCustomerCases(userId, db);
    if (!cases.length) return;

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
  };

  app.get("/api/customer/cases", async (req, res) => {
    try {
      if (!(await checkCustomerDevice(req, res))) return;

      const cases = await getCustomerCases(req.session.userId);
      res.json({ success: true, cases });
    } catch (error) {
      console.error("Customer cases load error:", error);
      res.status(500).json({ success: false, error: "Не удалось загрузить дела." });
    }
  });

  app.get("/api/customer/case-backups", async (req, res) => {
    try {
      if (!(await checkCustomerDevice(req, res))) return;

      const result = await pool.query(
        `SELECT id, created_at, octet_length(cases::text) AS size
         FROM rpm_case_backups
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC`,
        [req.session.userId]
      );

      res.json({
        success: true,
        backups: result.rows.map(row => ({
          filename: String(row.id),
          size: Number(row.size),
          createdAt: row.created_at
        }))
      });
    } catch (error) {
      console.error("Customer case backups load error:", error);
      res.status(500).json({
        success: false,
        error: "Не удалось загрузить резервные копии."
      });
    }
  });

  app.post("/api/customer/cases", async (req, res) => {
    if (!(await checkCustomerDevice(req, res))) return;

    const id = String(req.body?.id || randomUUID()).trim();
    const title = String(req.body?.title || "").trim().slice(0, 200);
    const data = req.body?.data && typeof req.body.data === "object" && !Array.isArray(req.body.data)
      ? req.body.data
      : {};
    const updatedAt = new Date().toISOString();

    if (!id || id.length > 200 || title.length < 1) {
      return res.status(400).json({
        success: false,
        error: "Название дела обязательно и должно быть не длиннее 200 символов."
      });
    }

    let db;
    let transactionStarted = false;

    try {
      db = await pool.connect();
      await db.query("BEGIN");
      transactionStarted = true;

      await backupCustomerCases(req.session.userId, db);

      const result = await db.query(
        `INSERT INTO rpm_cases (id, title, data, updated_at, user_id)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           data = EXCLUDED.data,
           updated_at = EXCLUDED.updated_at
         WHERE rpm_cases.user_id = EXCLUDED.user_id
         RETURNING id`,
        [id, title, JSON.stringify(data), updatedAt, req.session.userId]
      );

      if (!result.rowCount) {
        await db.query("ROLLBACK");
        transactionStarted = false;
        return res.status(409).json({
          success: false,
          error: "Дело с таким ID принадлежит другому аккаунту."
        });
      }

      await db.query("COMMIT");
      transactionStarted = false;
      res.json({
        success: true,
        case: { id, title, data, updatedAt }
      });
    } catch (error) {
      if (transactionStarted && db) {
        await db.query("ROLLBACK").catch(() => {});
      }
      console.error("Customer case save error:", error);
      res.status(500).json({ success: false, error: "Не удалось сохранить дело." });
    } finally {
      if (db) db.release();
    }
  });

  app.delete("/api/customer/cases/:id", async (req, res) => {
    if (!(await checkCustomerDevice(req, res))) return;

    let db;
    let transactionStarted = false;

    try {
      db = await pool.connect();
      await db.query("BEGIN");
      transactionStarted = true;

      await backupCustomerCases(req.session.userId, db);

      const result = await db.query(
        `DELETE FROM rpm_cases
         WHERE id = $1 AND user_id = $2
         RETURNING id`,
        [req.params.id, req.session.userId]
      );

      if (!result.rowCount) {
        await db.query("ROLLBACK");
        transactionStarted = false;
        return res.status(404).json({
          success: false,
          error: "Дело не найдено."
        });
      }

      await db.query("COMMIT");
      transactionStarted = false;
      res.json({ success: true });
    } catch (error) {
      if (transactionStarted && db) {
        await db.query("ROLLBACK").catch(() => {});
      }
      console.error("Customer case deletion error:", error);
      res.status(500).json({ success: false, error: "Не удалось удалить дело." });
    } finally {
      if (db) db.release();
    }
  });

  app.post("/api/customer/case-backups/restore", async (req, res) => {
    if (!(await checkCustomerDevice(req, res))) return;

    const backupId = Number(req.body?.filename);
    if (!Number.isSafeInteger(backupId) || backupId <= 0) {
      return res.status(400).json({
        success: false,
        error: "Некорректный номер резервной копии."
      });
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
        [backupId, req.session.userId]
      );

      if (!result.rowCount) {
        await db.query("ROLLBACK");
        transactionStarted = false;
        return res.status(404).json({
          success: false,
          error: "Резервная копия не найдена."
        });
      }

      const backupData = result.rows[0].cases;
      if (!Array.isArray(backupData)) {
        await db.query("ROLLBACK");
        transactionStarted = false;
        return res.status(400).json({
          success: false,
          error: "Формат резервной копии повреждён."
        });
      }

      await backupCustomerCases(req.session.userId, db);
      await db.query(
        "DELETE FROM rpm_cases WHERE user_id = $1",
        [req.session.userId]
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
            req.session.userId
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
      console.error("Customer case restore error:", error);
      res.status(error.code === "23505" ? 409 : 500).json({
        success: false,
        error: error.code === "23505"
          ? "Восстановление остановлено: ID одного из дел уже занят другим аккаунтом."
          : "Не удалось восстановить резервную копию."
      });
    } finally {
      if (db) db.release();
    }
  });

  const checkSupportAccess = async (req, res) => {
    if (!(await checkCustomerDevice(req, res))) {
      return false;
    }
    if (!req.session?.userId) {
      res.status(401).json({ error: "Требуется вход." });
      return false;
    }

    const roleResult = await pool.query(
      `SELECT role
       FROM rpm_users
       WHERE id = $1 AND status = 'active'`,
      [req.session.userId]
    );

    if (!roleResult.rowCount) {
      res.status(403).json({ error: "Аккаунт недоступен." });
      return false;
    }

    if (roleResult.rows[0].role === "admin") {
      return true;
    }

    const access = await pool.query(
      `SELECT 1
       FROM rpm_licenses
       WHERE user_id = $1
         AND status = 'active'
         AND expires_at > NOW()
       LIMIT 1`,
      [req.session.userId]
    );

    if (!access.rowCount) {
      res.status(403).json({ error: "Нет активной лицензии." });
      return false;
    }

    return true;
  };

  app.get("/api/customer/support/tickets", async (req, res) => {
    try {
      if (!(await checkSupportAccess(req, res))) return;

      const result = await pool.query(
        `SELECT
           t.id,
           t.subject,
           t.status,
           t.created_at,
           t.updated_at,
           t.last_message_at,
           (
             SELECT COUNT(*)::int
             FROM rpm_support_messages m
             WHERE m.ticket_id = t.id
               AND m.sender_type = 'admin'
               AND m.read_at IS NULL
           ) AS unread_count
         FROM rpm_support_tickets t
         WHERE t.user_id = $1
         ORDER BY t.last_message_at DESC, t.id DESC`,
        [req.session.userId]
      );

      res.json({ success: true, tickets: result.rows });
    } catch (error) {
      console.error("Support tickets lookup error:", error);
      res.status(500).json({ error: "Не удалось загрузить обращения." });
    }
  });

  app.post("/api/customer/support/tickets", async (req, res) => {
    const subject = String(req.body?.subject || "").trim();
    const message = String(req.body?.message || "").trim();

    if (subject.length < 3 || subject.length > 120) {
      return res.status(400).json({
        error: "Тема должна содержать от 3 до 120 символов."
      });
    }

    if (!message || message.length > 3000) {
      return res.status(400).json({
        error: "Сообщение должно содержать от 1 до 3000 символов."
      });
    }

    let db;

    try {
      if (!(await checkSupportAccess(req, res))) return;

      db = await pool.connect();
      await db.query("BEGIN");

      const ticket = await db.query(
        `INSERT INTO rpm_support_tickets (user_id, subject)
         VALUES ($1, $2)
         RETURNING id, subject, status, created_at, updated_at`,
        [req.session.userId, subject]
      );

      await db.query(
        `INSERT INTO rpm_support_messages
           (ticket_id, sender_type, sender_label, message)
         VALUES ($1, 'customer', 'Покупатель', $2)`,
        [ticket.rows[0].id, message]
      );

      await db.query(
        `UPDATE rpm_support_tickets
         SET updated_at = NOW(), last_message_at = NOW()
         WHERE id = $1`,
        [ticket.rows[0].id]
      );

      await db.query("COMMIT");

      res.status(201).json({
        success: true,
        ticket: ticket.rows[0]
      });
    } catch (error) {
      if (db) await db.query("ROLLBACK").catch(() => {});
      console.error("Support ticket creation error:", error);
      res.status(500).json({ error: "Не удалось создать обращение." });
    } finally {
      if (db) db.release();
    }
  });

  app.get("/api/customer/support/tickets/:id/messages", async (req, res) => {
    const ticketId = String(req.params.id);

    if (!/^[1-9]\d{0,18}$/.test(ticketId)) {
      return res.status(400).json({ error: "Некорректный ID обращения." });
    }

    try {
      if (!(await checkSupportAccess(req, res))) return;

      const ticket = await pool.query(
        `SELECT id, subject, status, created_at, updated_at
         FROM rpm_support_tickets
         WHERE id = $1 AND user_id = $2`,
        [ticketId, req.session.userId]
      );

      if (!ticket.rowCount) {
        return res.status(404).json({ error: "Обращение не найдено." });
      }

      await pool.query(
        `UPDATE rpm_support_messages
         SET read_at = NOW()
         WHERE ticket_id = $1
           AND sender_type = 'admin'
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
      console.error("Support messages lookup error:", error);
      res.status(500).json({ error: "Не удалось загрузить переписку." });
    }
  });

  app.post("/api/customer/support/tickets/:id/messages", async (req, res) => {
    const ticketId = String(req.params.id);
    const message = String(req.body?.message || "").trim();

    if (!/^[1-9]\d{0,18}$/.test(ticketId)) {
      return res.status(400).json({ error: "Некорректный ID обращения." });
    }

    if (!message || message.length > 3000) {
      return res.status(400).json({
        error: "Сообщение должно содержать от 1 до 3000 символов."
      });
    }

    let db;

    try {
      if (!(await checkSupportAccess(req, res))) return;

      db = await pool.connect();
      await db.query("BEGIN");

      const ticket = await db.query(
        `SELECT id, status
         FROM rpm_support_tickets
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [ticketId, req.session.userId]
      );

      if (!ticket.rowCount) {
        await db.query("ROLLBACK");
        return res.status(404).json({ error: "Обращение не найдено." });
      }

      if (ticket.rows[0].status === "closed") {
        await db.query("ROLLBACK");
        return res.status(409).json({
          error: "Закрытое обращение нельзя продолжить. Создайте новое обращение."
        });
      }

      await db.query(
        `INSERT INTO rpm_support_messages
           (ticket_id, sender_type, sender_label, message)
         VALUES ($1, 'customer', 'Покупатель', $2)`,
        [ticketId, message]
      );

      await db.query(
        `UPDATE rpm_support_tickets
         SET updated_at = NOW(),
             last_message_at = NOW()
         WHERE id = $1`,
        [ticketId]
      );

      await db.query("COMMIT");

      res.json({ success: true });
    } catch (error) {
      if (db) await db.query("ROLLBACK").catch(() => {});
      console.error("Support message creation error:", error);
      res.status(500).json({ error: "Не удалось отправить сообщение." });
    } finally {
      if (db) db.release();
    }
  });
  app.delete("/api/customer/support/tickets/:id", async (req, res) => {
    const ticketId = String(req.params.id);

    if (!/^[1-9]\d{0,18}$/.test(ticketId)) {
      return res.status(400).json({ error: "Некорректный ID обращения." });
    }

    try {
      if (!(await checkSupportAccess(req, res))) return;

      const result = await pool.query(
        `DELETE FROM rpm_support_tickets
         WHERE id = $1
           AND user_id = $2
           AND status = 'closed'
         RETURNING id`,
        [ticketId, req.session.userId]
      );

      if (!result.rowCount) {
        return res.status(404).json({
          error: "Закрытое обращение не найдено."
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Customer support ticket deletion error:", error);
      res.status(500).json({
        error: "Не удалось удалить обращение."
      });
    }
  });
}
