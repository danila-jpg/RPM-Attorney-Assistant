import { byId, element, request } from "./workspace-common.js";

const endpoint = "/api/workspace/clients";
const filters = byId("clientFilters");
const editor = byId("clientEditor");
const status = byId("clientStatus");
const saveStatus = byId("clientSaveStatus");
let page = 1;
let requestId = 0;
let editedId;
let editorVersion = 0;

function edit(client = {}) {
  editorVersion++;
  editedId = client.id;
  editor.reset();
  for (const name of ["rp_name", "contact", "organization", "notes"]) {
    editor.elements[name].value = client[name] || "";
  }
  editor.elements.archived.value = String(Boolean(client.archived_at));
  byId("clientEditorHeading").textContent = client.id ? "Карточка клиента" : "Новый клиент";
  saveStatus.textContent = "";
  editor.hidden = false;
  editor.elements.rp_name.focus();
}

async function load(requestedPage = 1) {
  const id = ++requestId;
  const params = new URLSearchParams(new FormData(filters));
  params.set("page", requestedPage);
  status.textContent = "Загрузка клиентов…";
  byId("clientPagination").hidden = true;
  byId("clientList").replaceChildren();
  try {
    const data = await request(`${endpoint}?${params}`);
    if (id !== requestId) return;
    page = requestedPage;
    status.textContent = data.clients.length ? `Страница ${page}` : "Клиенты не найдены.";
    for (const client of data.clients) {
      const card = element("article", null, { class: "panel" });
      card.append(element("h3", client.rp_name));
      if (client.organization) card.append(element("p", client.organization));
      if (client.contact) card.append(element("p", client.contact));
      card.append(element("p", "Добавлен " + new Date(client.created_at).toLocaleDateString("ru-RU")));
      const button = element("button", "Открыть карточку", { type: "button", class: "secondary" });
      button.addEventListener("click", async () => {
        const version = ++editorVersion;
        button.disabled = true;
        try {
          const result = await request(`${endpoint}/${client.id}`);
          if (version === editorVersion) edit(result.client);
        } catch (error) {
          if (version === editorVersion) status.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
      card.append(button);
      byId("clientList").append(card);
    }
    byId("clientPagination").hidden = !data.hasNext && page === 1;
    byId("clientPrevious").disabled = page === 1;
    byId("clientNext").disabled = !data.hasNext;
  } catch (error) {
    if (id === requestId) status.textContent = error.message;
  }
}

filters.addEventListener("submit", event => { event.preventDefault(); load(); });
byId("newClient").addEventListener("click", () => edit());
byId("clientPrevious").addEventListener("click", () => load(page - 1));
byId("clientNext").addEventListener("click", () => load(page + 1));
byId("closeClient").addEventListener("click", () => { editorVersion++; editor.hidden = true; byId("newClient").focus(); });

editor.addEventListener("submit", async event => {
  event.preventDefault();
  const submit = event.submitter;
  const version = editorVersion;
  const payload = Object.fromEntries(new FormData(editor));
  payload.archived = payload.archived === "true";
  submit.disabled = true;
  saveStatus.textContent = "Сохранение…";
  try {
    const result = await request(editedId ? `${endpoint}/${editedId}` : endpoint, editedId ? "PUT" : "POST", payload);
    if (version === editorVersion) {
      editedId = result.client.id;
      saveStatus.textContent = "Карточка сохранена.";
    }
    await load();
  } catch (error) {
    if (version === editorVersion) saveStatus.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

export function openView() {
  return load(page);
}
