const http = require("node:http");

const requests = [];

http
  .createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/requests") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(requests));
      return;
    }
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body });
      response.writeHead(204);
      response.end();
    });
  })
  .listen(8080, "0.0.0.0");
