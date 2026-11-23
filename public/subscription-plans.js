const plural = new Intl.PluralRules("ru");
const number = new Intl.NumberFormat("ru-RU");
const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" });

export const planPrice = amount => number.format(amount) + " RP";
export function planDuration(days, code = "") {
  days = days || Number(/^(\d+)_days$/.exec(code)?.[1]);
  if (!days) return code || "—";
  return days + " " + ({ one: "день", few: "дня", many: "дней" }[plural.select(days)] || "дней");
}

export async function loadPlans() {
  const response = await fetch("/api/subscription-plans");
  if (!response.ok) throw new Error("Не удалось загрузить тарифы.");
  return (await response.json()).plans;
}

export async function mountPlanCards(container, { expiresAt, select = false } = {}) {
  const plans = await loadPlans();
  container.replaceChildren();
  if (!plans.length) {
    container.textContent = "Доступных тарифов пока нет.";
    return;
  }
  const sort = document.createElement("select");
  sort.setAttribute("aria-label", "Сравнить тарифы");
  sort.add(new Option("Порядок каталога", "catalog"));
  sort.add(new Option("По цене", "amount"));
  sort.add(new Option("По длительности", "duration_days"));
  const grid = document.createElement("div");
  grid.className = "subscription-grid";
  const cards = plans.map(plan => {
    const card = document.createElement(select ? "label" : "article");
    card.className = "subscription-card";
    if (select) {
      const option = document.createElement("input");
      Object.assign(option, { type: "radio", name: "plan_code", value: plan.code, required: true,
        checked: plan.code === "30_days" || (!plans.some(item => item.code === "30_days") && plan === plans[0]) });
      card.append(option);
    }
    const term = document.createElement("strong");
    term.textContent = [plan.name, planDuration(plan.duration_days)].filter(Boolean).join(" · ");
    const price = document.createElement("span");
    price.className = "subscription-price";
    price.textContent = planPrice(plan.amount);
    card.append(term, price);
    if (select && expiresAt !== undefined) {
      const end = document.createElement("small");
      const start = Math.max(Date.now(), Date.parse(expiresAt) || 0);
      end.textContent = "Ориентировочно до " + date.format(start + plan.duration_days * 86400000);
      card.append(end);
    }
    return { plan, card };
  });
  function render() {
    const ordered = sort.value === "catalog" ? cards : [...cards].sort((a, b) => a.plan[sort.value] - b.plan[sort.value]);
    grid.replaceChildren(...ordered.map(({ card }) => card));
  }
  sort.onchange = render;
  container.append(sort, grid);
  render();
}
