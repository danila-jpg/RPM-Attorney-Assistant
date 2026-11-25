import { articles, searchTopics, tour } from "./public/help-content.js";
import { requestLimit } from "./request-limits.js";

const known = id => typeof id === "string" && Object.hasOwn(searchTopics, id);

export function registerHelp(app, { pool, requireOwner }) {
  app.use("/api/workspace/help", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/api/workspace/help", async (req, res) => {
    const [progress, votes, profile] = await Promise.all([
      pool.query("SELECT step,status FROM rpm_help_tour WHERE user_id=$1", [req.userId]),
      pool.query("SELECT article,helpful FROM rpm_help_votes WHERE user_id=$1", [req.userId]),
      pool.query("SELECT help_offer_on_first_visit FROM rpm_users WHERE id=$1", [req.userId])
    ]);
    res.json({ progress: progress.rows[0] ?? null, offer: profile.rows[0]?.help_offer_on_first_visit === true,
      votes: Object.fromEntries(votes.rows.map(row => [row.article, row.helpful])) });
  });

  app.put("/api/workspace/help/tour", async (req, res) => {
    const { step, status } = req.body ?? {};
    if (!Number.isInteger(step) || step < 0 || step >= tour.length || !["active", "skipped", "completed"].includes(status)) {
      return res.status(400).json({ error: "Некорректный шаг обучения." });
    }
    await pool.query(`INSERT INTO rpm_help_tour(user_id,step,status) VALUES($1,$2,$3)
      ON CONFLICT(user_id) DO UPDATE SET step=EXCLUDED.step,status=EXCLUDED.status`, [req.userId, step, status]);
    res.json({ step, status });
  });

  app.put("/api/workspace/help/vote", async (req, res) => {
    const { article, helpful } = req.body ?? {};
    if (!known(article) || typeof helpful !== "boolean") return res.status(400).json({ error: "Некорректная оценка." });
    await pool.query(`INSERT INTO rpm_help_votes(user_id,article,helpful) VALUES($1,$2,$3)
      ON CONFLICT(user_id,article) DO UPDATE SET helpful=EXCLUDED.helpful`, [req.userId, article, helpful]);
    res.json({ helpful });
  });

  app.post("/api/workspace/help/search", requestLimit(30, 60000), async (req, res) => {
    const { topic } = req.body ?? {};
    if (!known(topic)) return res.status(400).json({ error: "Неизвестная тема поиска." });
    await pool.query(`INSERT INTO rpm_help_search_counts(topic,total) VALUES($1,1)
      ON CONFLICT(topic) DO UPDATE SET total=rpm_help_search_counts.total+1`, [topic]);
    res.json({ success: true });
  });

  app.get("/api/owner/help-metrics", requireOwner, async (_req, res) => {
    const [votes, searches] = await Promise.all([
      pool.query(`SELECT article,COUNT(*) FILTER (WHERE helpful)::int AS yes,
        COUNT(*) FILTER (WHERE NOT helpful)::int AS no FROM rpm_help_votes GROUP BY article`),
      pool.query("SELECT topic,total::int FROM rpm_help_search_counts ORDER BY total DESC, topic LIMIT 10")
    ]);
    const byArticle = new Map(votes.rows.map(row => [row.article, row]));
    res.set("Cache-Control", "no-store").json({
      votes: articles.map(({ id, title }) => ({ title, yes: byArticle.get(id)?.yes ?? 0, no: byArticle.get(id)?.no ?? 0 })),
      searches: searches.rows.filter(row => known(row.topic)).map(row => ({ title: searchTopics[row.topic], total: row.total }))
    });
  });
}
