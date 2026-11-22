import { element, request } from "./workspace-common.js";
import { addIcon } from "./rpm-shell.js";

const categories = {
  court: "Судебное заседание", meeting: "Встреча", consultation: "Консультация",
  deadline: "Срок подачи документа", personal: "Личное событие"
};
const modes = { month: "Месяц", week: "Неделя", day: "День", list: "Список" };
const shortDays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const fullDate = new Intl.DateTimeFormat("ru", { dateStyle: "full" });
const monthDate = new Intl.DateTimeFormat("ru", { month: "long", year: "numeric" });
const eventTime = new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" });
const localDate = date => [date.getFullYear(), date.getMonth() + 1, date.getDate()]
  .map(value => String(value).padStart(2, "0")).join("-");
const midnight = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const shiftDay = (date, step) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + step);
const weekStart = date => shiftDay(date, -((date.getDay() + 6) % 7));
const api = "/api/workspace/events";
const action = (label, callback, attrs = {}) => {
  const control = element("button", label, { type: "button", class: "secondary", ...attrs });
  control.addEventListener("click", callback);
  return control;
};

export function calendar(container) {
  let selected = midnight(new Date());
  let mode = "month";
  let sequence = 0;
  let events = [];
  let ownedCases;
  const feedback = element("p", "", { role: "status" });
  const heading = element("h2");
  const output = element("div");
  const details = element("section", "", { class: "panel rpm-calendar-details" });
  const upcoming = element("section", "", { class: "panel rpm-calendar-details" });
  const toolbar = element("div", "", { class: "rpm-toolbar" });
  const segment = element("div", "", { class: "rpm-segments", role: "group", "aria-label": "Режим календаря" });
  const switches = Object.entries(modes).map(([key, label]) => action(label, () => {
    mode = key;
    refresh();
  }, { "data-mode": key }));
  segment.append(...switches);
  const move = step => {
    if (mode === "month") selected = new Date(selected.getFullYear(), selected.getMonth() + step, 1);
    else selected = shiftDay(selected, step * (mode === "week" ? 7 : mode === "list" ? 30 : 1));
    refresh();
  };
  const dateInput = element("input", "", { type: "date", "aria-label": "Перейти к дате" });
  dateInput.addEventListener("change", () => {
    if (dateInput.value) { selected = new Date(dateInput.value + "T00:00"); refresh(); }
  });
  const create = action("Создать событие", () => edit(), { class: "primary" });
  addIcon(create, "plus");
  toolbar.append(action("Сегодня", () => { selected = midnight(new Date()); refresh(); }),
    action("‹", () => move(-1), { "aria-label": "Предыдущий период" }),
    action("›", () => move(1), { "aria-label": "Следующий период" }), dateInput, create);
  const panel = element("section", "", { class: "panel" });
  panel.append(segment, heading, toolbar, feedback, output);
  container.replaceChildren(panel, details, upcoming);

  function eventButton(event, compact) {
    const time = new Date(event.starts_at);
    const category = categories[event.category] || categories.personal;
    const label = compact ? eventTime.format(time) + " " + event.title
      : time.toLocaleString("ru") + " · " + event.title + " · " + category;
    return action(label, () => edit(event), { class: "rpm-calendar-event", title: label, "data-category": event.category || "personal" });
  }

  function showEvents(target, title, records, empty) {
    target.replaceChildren(element("h2", title),
      ...(records.length ? records.map(event => eventButton(event, false)) : [element("p", empty)]));
  }

  function render(first, days) {
    const byDate = new Map();
    for (const event of events) {
      const key = localDate(new Date(event.starts_at));
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(event);
    }
    const key = localDate(selected);
    details.hidden = !["month", "week"].includes(mode);
    if (details.hidden) {
      showEvents(output, mode === "day" ? "События дня" : "События за период", events, "На этот период событий нет.");
      return;
    }
    const grid = element("div", "", { class: "rpm-calendar-grid", "aria-label": "Даты календаря" });
    grid.append(...shortDays.map(day => element("div", day, { class: "rpm-calendar-head" })));
    for (let i = 0; i < days; i++) {
      const date = shiftDay(first, i);
      const dateKey = localDate(date);
      const cell = element("div", "", { class: "rpm-calendar-cell" });
      if (mode === "month" && date.getMonth() !== selected.getMonth()) cell.dataset.outside = "";
      if (dateKey === key) cell.dataset.selected = "";
      const label = fullDate.format(date);
      const control = action(String(date.getDate()), () => {
        const changesMonth = mode === "month" && date.getMonth() !== selected.getMonth();
        selected = date;
        if (changesMonth) refresh();
        else {
          dateInput.value = dateKey;
          grid.querySelector("[data-selected]")?.removeAttribute("data-selected");
          grid.querySelector('[aria-pressed="true"]')?.setAttribute("aria-pressed", "false");
          cell.dataset.selected = "";
          control.setAttribute("aria-pressed", "true");
          showEvents(details, label, byDate.get(dateKey) || [], "На этот день событий нет.");
        }
      }, { class: "rpm-date", "aria-label": label, "aria-pressed": String(dateKey === key) });
      if (dateKey === localDate(new Date())) control.setAttribute("aria-current", "date");
      const records = byDate.get(dateKey) || [];
      cell.append(control, ...records.slice(0, 2).map(event => eventButton(event, true)));
      if (records.length > 2) cell.append(action("+" + (records.length - 2), () => control.click(),
        { class: "rpm-date", "aria-label": "Показать все события за " + label }));
      grid.append(cell);
    }
    output.replaceChildren(grid);
    showEvents(details, fullDate.format(selected), byDate.get(key) || [], "На этот день событий нет.");
  }

  async function refresh() {
    const current = ++sequence;
    const first = mode === "month" ? weekStart(new Date(selected.getFullYear(), selected.getMonth(), 1))
      : mode === "week" ? weekStart(selected) : selected;
    const days = { month: 42, week: 7, day: 1, list: 30 }[mode];
    const last = shiftDay(first, days);
    const query = new URLSearchParams({ from: first.toISOString(), to: last.toISOString() });
    dateInput.value = localDate(selected);
    heading.textContent = mode === "month" ? monthDate.format(selected) : mode === "day" ? fullDate.format(selected)
      : first.toLocaleDateString("ru") + " — " + shiftDay(last, -1).toLocaleDateString("ru");
    switches.forEach(control => control.setAttribute("aria-pressed", String(control.dataset.mode === mode)));
    feedback.textContent = "Загрузка…";
    output.setAttribute("aria-busy", "true");
    try {
      const [records, next] = await Promise.all([request(api + "?" + query), request(api)]);
      if (current !== sequence) return;
      events = records;
      render(first, days);
      showEvents(upcoming, "Ближайшие события", next.slice(0, 5), "Предстоящих событий нет.");
      feedback.textContent = "";
    } catch (error) {
      if (current === sequence) feedback.textContent = error.message;
    } finally {
      if (current === sequence) output.removeAttribute("aria-busy");
    }
  }

  async function edit(event) {
    const trigger = document.activeElement;
    const dialog = element("dialog", "", { class: "personal-dialog rpm-event-dialog", "aria-label": event ? "Редактировать событие" : "Создать событие" });
    const form = element("form");
    const title = element("input", "", { required: "", maxlength: "120" });
    title.value = event?.title || "";
    const date = element("input", "", { type: "datetime-local", required: "" });
    const time = event ? new Date(event.starts_at) : new Date(Math.max(+selected + 12 * 3600000, Date.now() + 3600000));
    date.value = localDate(time) + "T" + eventTime.format(time);
    const category = element("select");
    category.append(...Object.entries(categories).map(([key, label]) => new Option(label, key)));
    category.value = event?.category || "personal";
    const cases = element("select");
    cases.append(new Option("Без привязки", ""));
    cases.disabled = true;
    const description = element("p", "", { role: "status" });
    const save = element("button", "Сохранить", { class: "primary", type: "submit", disabled: "" });
    const actions = element("div", "", { class: "rpm-actions" });
    actions.append(save, action("Отмена", () => dialog.close()));
    const mutate = async (method, payload) => {
      Array.from(actions.children).forEach(control => { control.disabled = true; });
      try {
        await request(event ? api + "/" + event.id : api, method, payload);
        if (payload) selected = midnight(new Date(payload.startsAt));
        dialog.close();
        await refresh();
      } catch (error) {
        description.textContent = error.message;
        Array.from(actions.children).forEach(control => { control.disabled = false; });
      }
    };
    if (event) actions.append(action("Удалить", () => {
      if (confirm("Удалить это событие?")) mutate("DELETE");
    }, { class: "danger" }));
    const fields = [["Название", title], ["Дата и время", date], ["Категория", category], ["Дело", cases]];
    for (const [label, field] of fields) {
      const row = element("label", label);
      field.setAttribute("aria-label", label);
      row.append(field);
      form.append(row);
    }
    form.append(description, actions);
    form.addEventListener("submit", submission => {
      submission.preventDefault();
      mutate(event ? "PATCH" : "POST", { title: title.value, startsAt: new Date(date.value).toISOString(),
        category: category.value, caseId: cases.value || null });
    });
    dialog.append(element("h2", dialog.getAttribute("aria-label")), form);
    dialog.addEventListener("close", () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); });
    document.body.append(dialog);
    dialog.showModal();
    try {
      ownedCases ||= await request("/api/workspace/event-cases");
      cases.append(...ownedCases.map(item => new Option(item.title, item.id)));
      cases.value = event?.case_id || "";
      cases.disabled = false;
      save.disabled = false;
    } catch (error) {
      description.textContent = error.message;
      if (!event?.case_id) save.disabled = false;
    }
  }
  return refresh();
}
