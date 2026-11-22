export function requestLimit(limit, durationMs) {
  const windows = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (windows.size >= 1000) {
      for (const [key, window] of windows) if (window.until <= now) windows.delete(key);
    }
    const key = req.userId ? "account:" + req.userId : "ip:" + req.ip;
    let window = windows.get(key);
    if (!window || window.until <= now) {
      if (!window && windows.size >= 10000) windows.delete(windows.keys().next().value);
      window = { count: 0, until: now + durationMs };
      windows.set(key, window);
    }
    if (++window.count > limit) {
      return res.set("Retry-After", String(Math.ceil((window.until - now) / 1000)))
        .status(429).json({ error: "Слишком много запросов. Попробуйте позже." });
    }
    next();
  };
}
