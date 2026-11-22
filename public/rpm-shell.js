import { request } from "./workspace-common.js";

const paths = {
  "layout-dashboard": '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  bookmark: '<path d="m6 20 6-4 6 4V5a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  scale: '<path d="M12 3v18m-5 0h10M3 6h18M3 6l-2 7h6L5 6m14 0-2 7h6l-2-7"/>',
  shield: '<path d="M12 22s7-3 7-9V5l-7-3-7 3v8c0 6 7 9 7 9Z"/>',
  message: '<path d="M21 11.5a9 9 0 0 1-13 8l-5 1 1-5a9 9 0 1 1 17-4Z"/>',
  book: '<path d="M12 21c-2-2-6-3-10-2V4c4-1 8 0 10 2 2-2 6-3 10-2v15c-4-1-8 0-10 2V6"/>',
  briefcase: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V4h8v3M3 13h18"/>',
  files: '<path d="M15 2H7v16h13V7l-5-5v5h5M4 6v16h12"/>',
  history: '<path d="M3 12a9 9 0 1 1 3 7M3 5v7h7m2-5v5l3 2"/>',
  graduation: '<path d="m2 9 10-5 10 5-10 5-10-5Zm4 2v6c4 3 8 3 12 0v-6m4-2v7"/>',
  users: '<circle cx="9" cy="7" r="3"/><path d="M2 21v-3a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v3m2-17a3 3 0 0 1 0 6m1 4a4 4 0 0 1 3 4v3"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12a2 2 0 0 0 4 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>'
};

export function addIcon(node, name) {
  node.insertAdjacentHTML("afterbegin", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>');
}

const sidebar = document.getElementById("rpmSidebar");
if (sidebar) {
  document.querySelectorAll("[data-icon]").forEach(node => addIcon(node, node.dataset.icon));
  const body = document.body;
  const collapse = document.getElementById("collapseSidebar");
  const open = document.getElementById("openSidebar");
  const backdrop = document.getElementById("sidebarBackdrop");
  const profile = document.getElementById("panelProfile");
  const mobile = matchMedia("(max-width: 900px)");
  const setCollapsed = value => {
    body.classList.toggle("rpm-collapsed", value);
    collapse.setAttribute("aria-expanded", String(!value));
    collapse.title = value ? "Развернуть панель" : "Свернуть панель";
    collapse.setAttribute("aria-label", collapse.title);
  };
  try { setCollapsed(localStorage.getItem("rpm-sidebar-collapsed") === "true"); } catch {}
  function drawer(active, returnFocus = false) {
    body.classList.toggle("rpm-drawer", active);
    sidebar.inert = mobile.matches && !active;
    document.getElementById("rpmContent").inert = active;
    document.querySelector(".rpm-topbar-actions").inert = active;
    backdrop.hidden = !active;
    open.setAttribute("aria-expanded", String(active));
    if (active) sidebar.querySelector("a").focus();
    if (returnFocus && mobile.matches) open.focus();
  }
  drawer(false);
  mobile.addEventListener("change", () => drawer(false));
  open.addEventListener("click", () => drawer(!body.classList.contains("rpm-drawer"), true));
  backdrop.addEventListener("click", () => drawer(false, true));
  collapse.addEventListener("click", () => {
    if (mobile.matches) return drawer(false, true);
    const value = !body.classList.contains("rpm-collapsed");
    setCollapsed(value);
    try { localStorage.setItem("rpm-sidebar-collapsed", String(value)); } catch {}
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (profile.open) { profile.open = false; profile.querySelector("summary").focus(); }
    if (body.classList.contains("rpm-drawer")) drawer(false, true);
  });
  document.addEventListener("click", event => {
    if (!profile.contains(event.target)) profile.open = false;
  });
  document.getElementById("sidebarSearch").addEventListener("click", () => {
    drawer(false, true);
    document.getElementById("workspaceSearch").click();
  });
  window.addEventListener("rpm-route", ({ detail }) => {
    const nav = document.getElementById("mainNavigation");
    const selected = detail.tab === "charters"
      ? nav.querySelector(`[data-section="${detail.url.searchParams.get("view") === "history" ? "revisions" : detail.url.searchParams.get("type") === "charter" ? "charters" : "library"}"]`)
      : nav.querySelector(`[data-tab="${CSS.escape(detail.tab)}"]`);
    nav.querySelectorAll("[aria-current]").forEach(item => item.removeAttribute("aria-current"));
    selected?.setAttribute("aria-current", "page");
    document.getElementById("workspaceTitle").textContent = selected?.getAttribute("aria-label") || "Рабочее пространство";
    const wasOpen = body.classList.contains("rpm-drawer");
    drawer(false);
    if (wasOpen) document.getElementById("rpmContent").focus();
  });
  let admin = false;
  function applyPermissions(detail) {
    admin = detail.isAdmin === true;
    const allowed = { owner: detail.isOwner === true, admin, customer: detail.isCustomer === true };
    document.querySelectorAll("[data-role]").forEach(node => {
      node.hidden = !allowed[node.dataset.role] || (node.id === "adminWorkspaceLink" && !document.getElementById("admin"));
      if (node.dataset.tab && node.dataset.tab !== "admin") {
        const view = document.getElementById(node.dataset.tab);
        if (view) view.hidden = node.hidden;
      }
    });
    document.getElementById("rpmManagement").hidden = !admin && !allowed.owner;
    if (admin) {
      for (const [id, hash] of Object.entries({ workspaceAccount: "", workspaceSettings: "#profile", workspaceSecurity: "#security", workspaceAppearance: "#profile" })) {
        document.getElementById(id).href = "/admin" + hash;
      }
    }
  }
  window.addEventListener("rpm-permissions", ({ detail }) => applyPermissions(detail));
  if (window.rpmPermissions) applyPermissions(window.rpmPermissions);
  document.getElementById("workspaceLogout").addEventListener("click", async event => {
    const control = event.currentTarget;
    control.disabled = true;
    try {
      await request(admin ? "/api/admin/self/logout" : "/api/customer/logout", "POST", {});
      location.assign(admin ? "/admin-login" : "/app/");
    } catch (error) {
      document.getElementById("workspaceProfileStatus").textContent = error.message;
      control.disabled = false;
    }
  });
}
