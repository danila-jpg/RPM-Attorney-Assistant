(() => {
  function scan() {
    for (const input of document.querySelectorAll('input[type="password"]:not([data-visibility-control])')) {
      input.dataset.visibilityControl = "true";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "password-visibility";
      button.innerHTML = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/><path class="eye-slash" d="M3 3l18 18"/></svg>';
      const wrapper = document.createElement("span");
      wrapper.className = "password-field";
      input.before(wrapper);
      wrapper.append(input, button);
      function setVisible(visible) {
        input.type = visible ? "text" : "password";
        button.setAttribute("aria-pressed", String(visible));
        button.setAttribute("aria-label", visible ? "Скрыть пароль" : "Показать пароль");
      }
      setVisible(false);
      button.addEventListener("click", () => setVisible(input.type === "password"));
      input.form?.addEventListener("reset", () => setVisible(false));
    }
  }
  scan();
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
})();
