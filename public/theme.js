/* Browser-local appearance; never writes the vessel's shared day/night mode.
 * Loaded before the stylesheet so a saved override is applied before paint. */
window.AlertTheme = (() => {
  const storageKey = "signalk-alert-center.theme";
  const device = window.matchMedia("(prefers-color-scheme: dark)");
  const validPreference = (value) =>
    ["light", "dark"].includes(value) ? value : "auto";
  let preference = "auto";
  let sharedTheme;
  let storageAvailable = true;
  try {
    preference = validPreference(localStorage.getItem(storageKey));
  } catch {
    storageAvailable = false;
  }

  function render() {
    const theme =
      preference === "auto"
        ? (sharedTheme ?? (device.matches ? "dark" : "light"))
        : preference;
    const source =
      preference === "auto"
        ? `following ${sharedTheme ? "Signal K" : "device"}`
        : "browser override";
    const description = `${theme === "dark" ? "Dark" : "Light"} · ${source}`;
    document.documentElement.dataset.theme = theme;
    const toggle = document.querySelector("#theme-toggle");
    if (!toggle) return;
    toggle.title = description;
    document.querySelector("#theme-icon").textContent =
      theme === "dark" ? "☾" : "☀";
    document.querySelector("#theme-status").textContent = description;
    document.querySelector("#theme-storage-note").textContent = storageAvailable
      ? "Saved in this browser for this Signal K server."
      : "Browser storage is unavailable. This choice lasts for this page only.";
    for (const input of document.querySelectorAll('input[name="theme"]'))
      input.checked = input.value === preference;
  }

  device.addEventListener("change", render);
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = validPreference(event.newValue);
    render();
  });
  document.addEventListener("DOMContentLoaded", () => {
    const picker = document.querySelector("#theme-picker");
    const toggle = document.querySelector("#theme-toggle");
    picker.addEventListener("change", (event) => {
      if (event.target.name !== "theme") return;
      preference = validPreference(event.target.value);
      try {
        if (preference === "auto") localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, preference);
        storageAvailable = true;
      } catch {
        storageAvailable = false;
      }
      render();
    });
    document.addEventListener("click", (event) => {
      if (!picker.contains(event.target)) picker.open = false;
    });
    picker.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      picker.open = false;
      toggle.focus();
      event.preventDefault();
    });
    render();
  });
  render();
  return {
    setSignalKMode(value) {
      sharedTheme =
        value === "night" ? "dark" : value === "day" ? "light" : undefined;
      render();
    },
  };
})();
