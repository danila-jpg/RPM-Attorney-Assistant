import "./rpm-shell.js";

const paths = { admin: "/admin", charters: "/charters", training: "/training" };
const modules = {
  admin: () => import("./workspace-admin.js"),
  charters: () => import("./workspace-library.js"),
  training: () => import("./workspace-training.js"),
  dashboard: () => import("./workspace-personal.js"),
  calendar: () => import("./workspace-personal.js"),
  favorites: () => import("./workspace-personal.js")
};
let current;
let lastReset;

function renderRoute() {
  const url = new URL(location.href);
  const path = url.pathname.toLowerCase().replace(/\/$/, "");
  let tab = Object.keys(paths).find(id => paths[id] === path) || url.searchParams.get("tab") || "dashboard";
  const item = document.querySelector(`#mainNavigation [data-tab="${CSS.escape(tab)}"]`);
  if (item?.dataset.role && !window.rpmPermissionsReady) return;
  if (!item || item.hidden || !document.getElementById(tab)) tab = "dashboard";
  if (tab !== current) {
    current = tab;
    window.activateWorkspaceTab(tab);
  }
  window.dispatchEvent(new CustomEvent("rpm-route", { detail: { tab, url } }));
  if (tab === "analysis" && url.searchParams.has("new")) {
    if (lastReset !== url.href) window.resetWorkspaceAnalysis();
    lastReset = url.href;
  } else lastReset = undefined;
  if (tab === "analysis" && ["#documentExport", "#caseTitle"].includes(url.hash)) {
    document.getElementById(url.hash.slice(1))?.focus();
  }
  if (tab === "history" && url.searchParams.has("case")) window.openOwnedWorkspaceCase(url.searchParams.get("case"));
  if (Object.hasOwn(modules, tab)) {
    modules[tab]().then(module => {
      if (current === tab) return module.openView?.(new URL(location.href), tab);
    }).catch(() => {
      const status = document.getElementById(tab)?.querySelector('[role="status"]');
      if (status) status.textContent = "Раздел не загрузился. Обновите страницу и повторите попытку.";
    });
  }
}

function navigate(url) {
  const target = new URL(url, location.href);
  if (target.href !== location.href) history.pushState(null, "", target);
  renderRoute();
}

document.addEventListener("click", event => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const button = event.target.closest("#mainNavigation button[data-tab]");
  if (button) return navigate("/?tab=" + encodeURIComponent(button.dataset.tab));
  const link = event.target.closest("a[href]");
  if (!link || link.target || link.hasAttribute("download") || link.classList.contains("rpm-skip")) return;
  const url = new URL(link.href);
  if (url.origin !== location.origin || (!Object.values(paths).includes(url.pathname) && url.pathname !== "/")) return;
  if (url.pathname === "/admin" && !document.getElementById("admin")) return;
  if (link.getAttribute("href").startsWith("#") && url.pathname !== "/admin") return;
  event.preventDefault();
  navigate(url);
});
window.addEventListener("popstate", renderRoute);
window.addEventListener("rpm-permissions-ready", renderRoute);
window.rpmNavigate = navigate;
renderRoute();
