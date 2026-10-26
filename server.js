// server.js — прокси для раздела «Проверка API».
// Сторонние LLM-API часто запрещают вызовы из браузера (CORS),
// поэтому запросы идут через этот сервер от имени сайта.
const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = process.env.PORT || 8787;

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

// Защита от SSRF: запрещаем локальные и приватные адреса
function isPrivateHost(hostname) {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  if (/^0\./.test(hostname)) return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".localhost")) return true;
  return false;
}

const server = http.createServer((req, res) => {
  // CORS нужен только для локальной разработки (страница на другом порту)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const path = (req.url || "").split("?")[0];

  if (req.method === "GET" && path === "/api/health") return json(res, 200, { ok: true });

  if (req.method === "POST" && path === "/api/chat") {
    let body = "";
    let aborted = false;
    req.on("data", c => {
      body += c;
      if (body.length > 2e6) { aborted = true; req.destroy(); }
    });
    req.on("end", () => {
      if (aborted) return;
      let cfg;
      try { cfg = JSON.parse(body); } catch { return json(res, 400, { error: { message: "Неверный JSON в запросе" } }); }
      const { url, key, model, messages } = cfg || {};
      if (!url || typeof url !== "string" || !/^https:\/\//.test(url))
        return json(res, 400, { error: { message: "URL API должен начинаться с https://" } });
      if (!key || typeof key !== "string")
        return json(res, 400, { error: { message: "Не передан API ключ" } });

      let target;
      try { target = new URL(url.replace(/\/+$/, "") + "/chat/completions"); }
      catch { return json(res, 400, { error: { message: "Неверный URL API" } }); }
      if (isPrivateHost(target.hostname))
        return json(res, 400, { error: { message: "Этот адрес недоступен через прокси" } });

      const payload = JSON.stringify({
        model: typeof model === "string" && model ? model : "gpt-4o-mini",
        messages: Array.isArray(messages) ? messages : [],
        stream: false
      });

      const upstream = https.request(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + key,
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 120000
      }, up => {
        res.writeHead(up.statusCode, { "Content-Type": up.headers["content-type"] || "application/json; charset=utf-8" });
        up.pipe(res);
      });
      upstream.on("timeout", () => upstream.destroy(new Error("Таймаут запроса к API")));
      upstream.on("error", err => {
        if (res.headersSent) return res.end();
        json(res, 502, { error: { message: "Не удалось подключиться к API: " + err.message } });
      });
      upstream.end(payload);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end("{\"error\":{\"message\":\"Не найдено\"}}");
});

server.listen(PORT, "0.0.0.0", () => console.log("API-прокси слушает порт " + PORT));
