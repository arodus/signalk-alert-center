/* Native timeout rules share Alert Center's authenticated API and delivery UI. */
(() => {
  const dialog = document.querySelector("#native-timeout-dialog");
  const form = document.querySelector("#native-timeout-form");
  const result = document.querySelector("#native-timeout-result");
  document
    .querySelector("#native-timeout-add")
    .addEventListener("click", async () => {
      result.textContent = "";
      dialog.showModal();
      const prerequisite = document.querySelector(
        "#native-timeout-prerequisite",
      );
      prerequisite.textContent = "Checking native data timeout settings…";
      try {
        const status = await api("/native-timeout-rules");
        prerequisite.textContent = status.message;
      } catch (error) {
        prerequisite.textContent = error.message;
      }
    });
  document
    .querySelector("#native-timeout-close")
    .addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const data = new FormData(form);
      // Random identity is independent of the editable human-readable name.
      const definition = await api("/native-timeout-rules", {
        method: "POST",
        body: JSON.stringify({
          slug: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
          name: data.get("name").trim(),
          path: data.get("path").trim(),
          severity: data.get("severity"),
        }),
      });
      dialog.close();
      form.reset();
      await load();
      await openPolicy(definition.id, definition);
    } catch (error) {
      result.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
})();
