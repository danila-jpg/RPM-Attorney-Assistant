import { byId, element, request, sourceLink } from "./workspace-common.js";

import { favoriteControl } from "./workspace-personal.js";

const select = byId("documents");
const status = byId("libraryStatus");
const search = byId("search");
const retry = byId("retryLibrary");
let generation = 0;
let current;
let pending;
let catalog;
let documents = [];
let libraryType;
let revisions;
const organization = byId("libraryOrganization");
const catalogSearch = byId("libraryCatalogSearch");

function renderCatalog() {
  const term = catalogSearch.value.trim().toLocaleLowerCase("ru");
  const filtered = documents.filter(doc => (!libraryType || doc.type === libraryType) &&
    (!organization.value || categoryOf(doc) === organization.value) &&
    `${doc.name} ${categoryOf(doc)}`.toLocaleLowerCase("ru").includes(term));
  const selected = select.value;
  select.replaceChildren(element("option", "Выберите документ", { value: "" }), ...filtered.map(doc =>
    element("option", doc.name, { value: doc.id })));
  select.value = filtered.some(doc => doc.id === selected) ? selected : "";
  const cards = filtered.filter(doc => doc.type !== "law" || organization.value || term);
  byId("documentCards").replaceChildren(...(cards.length ? cards.map(doc => {
    const card = element("article", null, { class: "document-card" });
    card.append(element("a", doc.name, { href: sourceLink(doc.id) }), element("small", categoryOf(doc)));
    return card;
  }) : [element("p", "Документы не найдены.")]));
}
const categoryOf = doc => doc.organization || (doc.type === "law" ? "Законодательство" : "Документы");
organization.addEventListener("change", renderCatalog);
catalogSearch.addEventListener("input", renderCatalog);

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = message;
  } catch {
    const fallback = element("textarea", null, { readonly: "", "aria-label": "Текст для копирования" });
    fallback.value = text;
    status.replaceChildren(element("p", "Выделенный текст можно скопировать вручную."), fallback);
    fallback.focus();
    fallback.select();
  }
}

function goToAnchor(hash) {
  const target = byId(hash.slice(1));
  if (target?.id === "documentHistory" && !target.hidden) {
    target.open = true;
    target.scrollIntoView();
    return;
  }
  if (!target?.closest("#text")) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === "DETAILS") parent.open = true;
  }
  target.scrollIntoView();
}

function updateReadingProgress() {
  const text = byId("text");
  if (!text.getClientRects().length) return;
  const { top, height } = text.getBoundingClientRect();
  byId("readingProgress").value = Math.min(100, Math.max(0, (innerHeight - top) / Math.max(1, height) * 100));
}
window.addEventListener("scroll", updateReadingProgress, { passive: true });
window.addEventListener("resize", updateReadingProgress);
byId("reader").addEventListener("toggle", updateReadingProgress, true);
byId("libraryBackTop").addEventListener("click", () => byId("libraryTop").scrollIntoView());
byId("copyDocument").addEventListener("click", () => current && copy(current.fullText, "Документ скопирован."));

function copyButton(id, anchor) {
  const control = element("button", "Копировать ссылку", { type: "button", class: "secondary" });
  control.addEventListener("click", async () => {
    const link = new URL(sourceLink(id, anchor), location.origin).href;
    await copy(link, "Ссылка скопирована.");
  });
  return control;
}

async function openDocument(id) {
  const version = ++generation;
  retry.hidden = true;
  status.textContent = "Загрузка документа…";
  byId("reader").hidden = true;
  try {
    const doc = await request(`/api/documents/${encodeURIComponent(id)}`);
    if (version !== generation) return;
    current = doc;
    const training = byId("trainOnDocument");
    training.hidden = doc.status === "archived";
    training.href = "/training?doc=" + encodeURIComponent(doc.id);
    byId("libraryCatalog").hidden = false;
    const revision = doc.revision || "дата редакции неизвестна";
    const heading = byId("title");
    heading.replaceChildren(document.createTextNode(doc.name + " "), favoriteControl("document", doc.id, status));
    byId("metadata").textContent = [doc.organization, revision, doc.status === "archived" ? "Архив" : "Действующий документ", doc.source].filter(Boolean).join(" · ");
    const history = byId("documentHistory");
    history.hidden = !doc.history.length;
    const comparison = byId("revisionComparison");
    comparison.replaceChildren();
    const compare = async (id, button) => {
      button.disabled = true;
      comparison.textContent = "Загрузка сравнения…";
      try {
        const params = new URLSearchParams({ before: id, after: doc.id });
        const result = await request("/api/law-revisions?" + params);
        if (current?.id !== doc.id) return;
        const labels = { added: "Добавлено", removed: "Удалено", changed: "Изменено", unchanged: "Без изменений" };
        const list = element("div");
        const filter = element("input", null, { type: "search", "aria-label": "Поиск в сравнении", placeholder: "Номер статьи или фраза" });
        const render = () => {
          const term = filter.value.trim().toLowerCase();
          const rows = result.changes.filter(change => (!term || [change.before, change.after]
            .some(entry => entry && [entry.number, entry.title, entry.text].join(" ").toLowerCase().includes(term))));
          list.replaceChildren(...rows.map(change => {
            const row = element("details", null, { class: "revision-row", "data-change": change.status });
            const entry = change.after || change.before;
            row.append(element("summary", labels[change.status] + (change.moved ? " · перенумеровано" : "") + " · " + entry.title));
            if (change.before && change.status !== "unchanged") row.append(element("p", "Было — " + change.before.text));
            if (change.after) row.append(element("p", (change.status === "unchanged" ? "" : "Стало — ") + change.after.text));
            return row;
          }));
          if (!rows.length) list.textContent = "Совпадений нет.";
        };
        filter.addEventListener("input", render);
        comparison.replaceChildren(element("h3", [result.before.revision, result.after.revision].filter(Boolean).join(" → ") || "Сравнение редакций"), filter, list);
        render();
      } catch (error) {
        if (current?.id === doc.id) comparison.textContent = error.message;
      } finally { button.disabled = false; }
    };
    history.querySelector("ul").replaceChildren(...doc.history.map(old => {
      const item = element("li");
      item.append(element("a", old.revision || "Предыдущая редакция", { href: sourceLink(old.id) }));
      if (old.id !== doc.id) {
        const button = element("button", "Сравнить с открытой", { type: "button", class: "secondary" });
        button.addEventListener("click", () => void compare(old.id, button));
        item.append(button);
      }
      return item;
    }));
    const toc = doc.structure.filter(entry => ["chapter", "section", "article"].includes(entry.kind));
    byId("contents").hidden = !toc.length;
    byId("contents").querySelector("ul").replaceChildren(...toc.map(entry => {
      const item = element("li");
      item.append(element("a", entry.title, { href: "#" + entry.id }));
      return item;
    }));
    const lines = doc.fullText.split(/\r?\n/);
    const first = doc.structure[0]?.line ?? lines.length;
    const blocks = [element("div", lines.slice(0, first).join("\n"), { id: doc.structure.length ? "document-start" : "line-1", class: "document-text" })];
    let section;
    for (const [index, entry] of doc.structure.entries()) {
      const block = element("div", null, { id: entry.id, class: "norm" });
      const end = doc.structure[index + 1]?.line ?? lines.length;
      const heading = ["chapter", "section", "article"].includes(entry.kind);
      if (heading) {
        section = element("details", null, { class: "document-section", open: "" });
        section.append(element("summary", entry.title));
        blocks.push(section);
      }
      const text = lines.slice(entry.line + Number(heading), end).join("\n");
      const actions = element("details", null, { class: "norm-actions" });
      const copyPoint = element("button", "Копировать текст", { type: "button", class: "secondary" });
      copyPoint.addEventListener("click", () => copy(lines.slice(entry.line, end).join("\n"), "Пункт скопирован."));
      actions.append(element("summary", "Действия"), copyPoint, copyButton(doc.id, entry.id), favoriteControl(doc.type === "law" ? "law" : "charter", doc.id + ":" + entry.id, status));
      block.append(element("div", text, { class: "document-text" }), actions);
      if (section) section.append(block);
      else blocks.push(block);
    }
    byId("text").replaceChildren(...blocks);
    search.value = "";
    byId("matches").hidden = true;
    byId("reader").hidden = false;
    status.textContent = "";
    goToAnchor(location.hash);
    updateReadingProgress();
  } catch (error) {
    if (version === generation) {
      status.textContent = error.message;
      retry.hidden = false;
    }
  } finally {
    if (version === generation) pending = undefined;
  }
}

search.addEventListener("input", () => {
  const term = search.value.trim().toLowerCase();
  const list = byId("matches");
  list.hidden = !term;
  for (const node of byId("text").querySelectorAll(".document-text, .document-section > summary")) {
    const text = node.textContent;
    node.textContent = "";
    if (!term) { node.textContent = text; continue; }
    const lower = text.toLowerCase();
    let cursor = 0;
    for (let match = lower.indexOf(term); match >= 0; match = lower.indexOf(term, cursor)) {
      node.append(text.slice(cursor, match), element("mark", text.slice(match, match + term.length)));
      cursor = match + term.length;
    }
    node.append(text.slice(cursor));
  }
  if (!term || !current) return;
  const lines = current.fullText.split(/\r?\n/);
  const matches = [];
  let entryIndex = -1;
  for (const [index, line] of lines.entries()) {
    if (current.structure[entryIndex + 1]?.line === index) entryIndex++;
    if (!line.toLowerCase().includes(term)) continue;
    const item = element("li");
    item.append(element("a", line.trim(), { href: "#" + (current.structure[entryIndex]?.id || (current.structure.length ? "document-start" : "line-1")) }));
    matches.push(item);
    if (matches.length === 50) break;
  }
  list.replaceChildren(...(matches.length ? matches : [element("li", "Совпадений нет.")]));
});

select.addEventListener("change", () => {
  window.rpmNavigate(select.value ? sourceLink(select.value) : "/charters");
});
byId("resolve").addEventListener("submit", async event => {
  event.preventDefault();
  const input = new FormData(event.currentTarget).get("reference");
  const output = byId("resolution");
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  output.textContent = "Поиск нормы…";
  try {
    const data = await request("/api/documents/resolve?q=" + encodeURIComponent(input));
    output.replaceChildren(element("p", data.message), ...data.matches.slice(0, 8).map(match => {
      const result = element("div");
      result.append(element("a", match.reference, { href: sourceLink(match.documentId, match.id) }));
      if (data.status === "confirmed") result.append(element("p", match.text, { class: "source" }));
      return result;
    }));
  } catch (error) { output.textContent = error.message; }
  finally { button.disabled = false; }
});
async function loadCatalog() {
  documents = await request("/api/documents");
  organization.replaceChildren(element("option", "Все организации", { value: "" }),
    ...[...new Set(documents.map(categoryOf))].map(name => element("option", name, { value: name })));
  renderCatalog();
  return documents;
}
export async function openView(url) {
  retry.hidden = true;
  try {
    if (!catalog) {
      status.textContent = "Загрузка списка документов…";
      catalog = loadCatalog().catch(error => { catalog = undefined; throw error; });
    }
    await catalog;
    if (url.href !== location.href) return;
    const nextType = url.searchParams.get("type") === "charter" ? "charter" : undefined;
    if (libraryType !== nextType) {
      libraryType = nextType;
      organization.value = "";
      renderCatalog();
    }
    const history = url.searchParams.get("view") === "history";
    const revisionPanel = byId("libraryRevisions");
    revisionPanel.hidden = !history;
    byId("libraryCatalog").hidden = history;
    byId("libraryTop").textContent = history ? "История редакций" : libraryType ? "Уставы" : "Документы";
    if (history) {
      revisions ||= request("/api/law-revisions").catch(error => { revisions = undefined; throw error; });
      const { revisions: entries } = await revisions;
      if (url.href !== location.href) return;
      const archived = entries.filter(entry => entry.status === "archived");
      const list = element("ul", "", { class: "personal-results" });
      for (const item of archived) {
        const row = element("li");
        row.append(element("a", [item.name, item.revision].filter(Boolean).join(" · "), { href: sourceLink(item.id) }));
        const active = entries.find(entry => entry.documentId === item.documentId && entry.status !== "archived");
        if (active) row.append(element("a", "Сравнить редакции", { href: sourceLink(active.id) + "#documentHistory" }));
        list.append(row);
      }
      revisionPanel.replaceChildren(archived.length ? list : element("p", "Архивных редакций пока нет."));
    }
    const selected = url.searchParams.get("doc");
    if (!selected) {
      generation++;
      pending = undefined;
      current = undefined;
      select.value = "";
      byId("reader").hidden = true;
      byId("documentHistory").hidden = true;
      status.textContent = documents.length ? "" : "Документы пока отсутствуют.";
      return;
    }
    if (![...select.options].some(option => option.value === selected)) {
      select.append(element("option", "Указанная редакция", { value: selected }));
    }
    select.value = selected;
    if (pending === selected) return;
    if (current?.id === selected && !pending && !byId("reader").hidden) {
      goToAnchor(url.hash);
      return;
    }
    pending = selected;
    await openDocument(selected);
  } catch (error) {
    status.textContent = error.message;
    retry.hidden = false;
  }
}
byId("contents").addEventListener("click", event => {
  const link = event.target.closest("a[href^='#']");
  if (link) requestAnimationFrame(() => goToAnchor(link.hash));
});
byId("matches").addEventListener("click", event => {
  const link = event.target.closest("a[href^='#']");
  if (link) requestAnimationFrame(() => goToAnchor(link.hash));
});
retry.addEventListener("click", () => openView(new URL(location.href)));
