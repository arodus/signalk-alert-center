import { AlertDatabase } from "../storage/db";

interface ResponseLike {
  status(code: number): ResponseLike;
  json(value: unknown): void;
}

interface RouterLike {
  get(
    path: string,
    handler: (request: unknown, response: ResponseLike) => void,
  ): void;
  post(
    path: string,
    handler: (request: unknown, response: ResponseLike) => void,
  ): void;
}

export function registerRoutes(
  router: RouterLike,
  database: () => AlertDatabase | undefined,
  status: () => unknown,
  runScheduler: () => Promise<void>,
): void {
  router.get("/status", (_request, response) => {
    response.json(status());
  });
  router.get("/alerts", (_request, response) =>
    response.json(database()?.listAlerts() ?? []),
  );
  router.get("/deliveries", (_request, response) =>
    response.json(database()?.listDeliveries() ?? []),
  );
  router.post("/retry", async (_request, response) => {
    const current = database();
    if (!current) {
      response.status(503).json({ error: "Plugin is not started" });
      return;
    }
    current.retryFailedDeliveries();
    await runScheduler();
    response.json({ status: "scheduled" });
  });
}
