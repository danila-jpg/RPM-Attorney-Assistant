import { mountAppearance } from "./appearance.js";
import { byId, element, request } from "./workspace-common.js";

const profileForm = byId("profileForm");
const passwordForm = byId("passwordForm");
const status = byId("profileStatus");
const securityStatus = byId("securityStatus");
const date = value => new Date(value).toLocaleString("ru");
const sections = [...document.querySelectorAll(".admin-view")];
const sectionLinks = [...document.querySelectorAll('.admin-nav a[href^="#"]')];
const avatarInput = profileForm.elements.avatar;
const removeAvatar = profileForm.elements.remove;
const avatarStatus = byId("avatarStatus");
let savedAvatar;
let avatarRead;

function showSection() {
  const requested = location.hash.slice(1);
  const active = sections.some(section => section.id === requested) ? requested : "dashboard";
  for (const section of sections) section.hidden = section.id !== active;
  for (const link of sectionLinks) {
    const selected = link.hash === "#" + active;
    link.classList.toggle("active", selected);
    if (selected) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}

function showProfile(profile) {
  byId("greeting").textContent = `Здравствуйте, ${profile.display_name || profile.username}`;
  mountAppearance(byId("appearanceSettings"), "/api/admin/self/profile", profile);
  for (const key of ["username", "rp_nickname", "display_name"]) profileForm.elements[key].value = profile[key] || "";
  passwordForm.elements.username.value = profile.username;
  savedAvatar = profile.avatar_data;
  showAvatar(savedAvatar);
}

function showAvatar(value) {
  const avatar = byId("avatar");
  avatar.hidden = !/^data:image\/(png|jpeg|webp);base64,/i.test(value || "");
  if (avatar.hidden) avatar.removeAttribute("src");
  else avatar.src = value;
}

avatarInput.addEventListener("change", async () => {
  const file = avatarInput.files[0];
  avatarStatus.textContent = "";
  removeAvatar.checked = false;
  avatarRead = undefined;
  if (!file) return showAvatar(savedAvatar);
  if (file.size > 500_000 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    avatarInput.value = "";
    showAvatar(savedAvatar);
    avatarStatus.textContent = "Выберите изображение PNG, JPEG или WebP размером до 500 КБ.";
    return;
  }
  const reading = new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Не удалось прочитать аватар."));
    reader.readAsDataURL(file);
  });
  avatarRead = reading;
  try {
    const data = await reading;
    if (avatarRead === reading && !removeAvatar.checked) showAvatar(data);
  } catch (error) {
    if (avatarRead === reading) avatarStatus.textContent = error.message;
  }
});
removeAvatar.addEventListener("change", async () => {
  if (removeAvatar.checked) showAvatar(null);
  else showAvatar(await avatarRead?.catch(() => null) || savedAvatar);
});

async function loadProfile({ refreshForm = false } = {}) {
  const { profile, stats, history } = await request("/api/admin/self");
  if (refreshForm) showProfile(profile);
  byId("stats").textContent = stats ? `Дел: ${stats.cases}. Завершённых занятий: ${stats.training}.` : "Статистика временно недоступна.";
  byId("adminHistory").replaceChildren(...(history?.length ? history.map(row =>
    element("li", `${date(row.created_at)} · ${row.action} · ${row.result}`)) :
    [element("li", history ? "Пока нет действий" : "История временно недоступна.")]));
}

async function loadSessions() {
  const [sessions, devices] = await Promise.all([request("/api/admin/self/sessions"), request("/api/admin/self/devices")]);
  byId("sessions").replaceChildren(...sessions.map(session => {
    const item = element("li", `${session.device_name || "Устройство"} · ${date(session.last_seen_at)}${session.current ? " · текущая сессия" : " "}`);
    if (!session.current) {
      const button = element("button", "Завершить", { type: "button", class: "secondary" });
      button.addEventListener("click", () => revoke(session.id));
      item.append(button);
    }
    return item;
  }));
  byId("devices").replaceChildren(...devices.map(device => {
    const item = element("li", `${device.device_name || "Устройство"} · ${date(device.last_seen_at)}${device.current ? " · текущее" : " "}`);
    if (!device.current) {
      const button = element("button", "Отключить", { type: "button", class: "secondary" });
      button.addEventListener("click", () => action(securityStatus, async () => {
        const data = await request(`/api/admin/self/devices/${encodeURIComponent(device.id)}`, "DELETE");
        await Promise.all([loadSessions(), loadProfile()]);
        return data.revoked ? "Устройство отключено." : "Устройство уже отключено.";
      }));
      item.append(button);
    }
    return item;
  }));
}

async function action(target, handler) {
  delete target.dataset.error;
  target.textContent = "Загрузка…";
  try { target.textContent = await handler(); }
  catch (error) {
    target.dataset.error = "true";
    target.textContent = error.message;
  }
}

function revoke(id) {
  return action(securityStatus, async () => {
    const data = await request(`/api/admin/self/sessions/${id}`, "DELETE");
    await Promise.all([loadSessions(), loadProfile()]);
    return data.revoked ? "Сессии завершены." : "Активных сессий для завершения нет.";
  });
}

profileForm.addEventListener("submit", event => {
  event.preventDefault();
  action(status, async () => {
    const data = new FormData(profileForm);
    const body = { rp_nickname: data.get("rp_nickname"), display_name: data.get("display_name") };
    if (data.has("remove")) body.avatar_data = null;
    else if (avatarRead) body.avatar_data = await avatarRead;
    const { profile } = await request("/api/admin/self/profile", "PUT", body);
    profileForm.reset();
    avatarRead = undefined;
    avatarStatus.textContent = "";
    showProfile(profile);
    window.dispatchEvent(new CustomEvent("rpm-profile-updated", { detail: profile }));
    loadProfile().catch(() => { byId("adminHistory").textContent = "История временно недоступна."; });
    return "Профиль сохранён.";
  });
});
passwordForm.addEventListener("submit", event => {
  event.preventDefault();
  action(securityStatus, async () => {
    try {
      await request("/api/admin/self/password", "POST", Object.fromEntries(new FormData(passwordForm)));
      passwordForm.reset();
      return "Пароль изменён.";
    } finally {
      loadProfile().catch(() => { byId("adminHistory").textContent = "История временно недоступна."; });
    }
  });
});
byId("revoke").addEventListener("click", () => revoke("others"));
byId("logout").addEventListener("click", () => action(securityStatus, async () => {
  await request("/api/admin/self/logout", "POST");
  location.assign("/admin-login");
  return "Сессия завершена.";
}));
window.addEventListener("hashchange", showSection);
export function openView() { showSection(); }
action(byId("loadStatus"), async () => { await loadProfile({ refreshForm: true }); return ""; });
action(securityStatus, async () => { await loadSessions(); return ""; });
