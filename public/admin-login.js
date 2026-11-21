document.getElementById("login").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button:not([type="button"])');
  const status = document.getElementById("status");
  button.disabled = true;
  status.textContent = "Вход…";
  try {
    const response = await fetch("/api/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form)))
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось войти.");
    location.assign("/admin");
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
