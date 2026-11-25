import { byId, element, request } from "./workspace-common.js";

const panel = byId("ownerHelpMetrics");
const status = panel.querySelector("[role=status]");
const results = panel.querySelector("[data-help-totals]");
const refresh = panel.querySelector("button");

function table(headers, rows) {
  const wrapper = element("div", null, { class: "table-wrap" });
  const grid = element("table");
  const head = grid.createTHead().insertRow();
  head.append(...headers.map(title => element("th", title, { scope: "col" })));
  const body = grid.createTBody();
  for (const row of rows) body.insertRow().append(...row.map(value => element("td", value)));
  wrapper.append(grid);
  return wrapper;
}

async function load() {
  refresh.disabled = true;
  status.textContent = "Загрузка…";
  try {
    const { votes, searches } = await request("/api/owner/help-metrics");
    results.replaceChildren(
      element("h3", "Полезность инструкций"),
      table(["Инструкция", "Да", "Нет"], votes.map(item => [item.title, item.yes, item.no])),
      element("h3", "Популярные темы поиска"),
      searches.length ? table(["Тема", "Количество"], searches.map(item => [item.title, item.total])) : element("p", "Данных пока нет.")
    );
    status.textContent = "";
  } catch {
    status.textContent = "Не удалось загрузить статистику.";
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener("click", load);
panel.addEventListener("toggle", () => {
  if (panel.open && !results.childElementCount && !refresh.disabled) void load();
});
