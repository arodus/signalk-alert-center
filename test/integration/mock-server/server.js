const http = require("node:http");

const requests = [];
let outcomes = [];

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

http
  .createServer(async (request, response) => {
    if (request.url === "/health") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/requests") {
      sendJson(response, 200, requests);
      return;
    }
    if (request.method === "POST" && request.url === "/reset") {
      requests.length = 0;
      outcomes = [];
      sendJson(response, 200, { reset: true });
      return;
    }
    if (request.method === "PUT" && request.url === "/outcomes") {
      const body = await readBody(request);
      let value;
      try {
        value = JSON.parse(body);
      } catch {
        sendJson(response, 400, { error: "Body must be valid JSON" });
        return;
      }
      if (!Array.isArray(value)) {
        sendJson(response, 400, { error: "Body must be an array" });
        return;
      }
      outcomes = value.map((outcome) => ({
        status: Number(outcome.status ?? 204),
        delayMs: Number(outcome.delayMs ?? 0),
        body: outcome.body ?? "",
        headers: outcome.headers ?? {},
      }));
      sendJson(response, 200, { queued: outcomes.length });
      return;
    }

    const body = await readBody(request);
    let json;
    try {
      json = body === "" ? undefined : JSON.parse(body);
    } catch {
      json = undefined;
    }
    requests.push({
      sequence: requests.length + 1,
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
      json,
      receivedAt: new Date().toISOString(),
    });
    const outcome = outcomes.shift() ?? {
      status: 204,
      delayMs: 0,
      body: "",
      headers: {},
    };
    if (outcome.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, outcome.delayMs));
    }
    response.writeHead(outcome.status, outcome.headers);
    response.end(
      typeof outcome.body === "string"
        ? outcome.body
        : JSON.stringify(outcome.body),
    );
  })
  .listen(8080, "0.0.0.0");
