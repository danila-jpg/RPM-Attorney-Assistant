export const byId = id => document.getElementById(id);

export function element(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

export async function request(url, method = "GET", body) {
  const signal = AbortSignal.timeout(12000);
  let response, data;
  try {
    response = await fetch(url, {
      signal, method, headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.headers.get("content-type")?.includes("application/json")) data = await response.json();
  } catch (error) {
    if (error.name === "TimeoutError") throw new Error("Сервер не ответил вовремя. Повторите запрос.");
    throw new Error("Не удалось связаться с сервером. Повторите запрос.");
  }
  if (!response.ok || !data) throw new Error(data?.error || data?.message || "Запрос завершился ошибкой.");
  return data;
}

export function sourceLink(documentId, anchor) {
  return `/charters?doc=${encodeURIComponent(documentId)}${anchor ? "#" + encodeURIComponent(anchor) : ""}`;
}
