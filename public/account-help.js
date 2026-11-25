import { byId, request } from "./workspace-common.js";

const offer = byId("accountHelpOffer");
const skip = offer.querySelector("button");
const status = offer.querySelector("[role=status]");
const endpoint = "/api/workspace/help";

request(endpoint).then(data => {
  offer.hidden = !data.offer || Boolean(data.progress);
}).catch(() => {});

skip.addEventListener("click", async () => {
  skip.disabled = true;
  status.textContent = "";
  try {
    await request(endpoint + "/tour", "PUT", { step: 0, status: "skipped" });
    offer.hidden = true;
  } catch {
    status.textContent = "Не удалось сохранить выбор. Повторите попытку.";
  } finally {
    skip.disabled = false;
  }
});
