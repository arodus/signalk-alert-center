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
interface RequestLike {
  params?: Record<string, string>;
}

export function registerRoutes(
  router: RouterLike,
  database: () => AlertDatabase | undefined,
  status: () => unknown,
  runScheduler: () => Promise<void>,
  catalog: () => unknown,
  removeAlert: (id: string) => boolean,
  acknowledgeAlert: (id: string) => boolean,
  silenceAlert: (id: string) => boolean,
): void {
  router.get("/status", (_request, response) => {
    response.json(status());
  });
  router.get("/alerts", (_request, response) => response.json(catalog()));
  router.post("/alerts/:id/remove", (request, response) => {
    const id = (request as RequestLike).params?.id;
    if (!id || !removeAlert(id)) {
      response.status(404).json({ error: "One-time alert was not found" });
      return;
    }
    response.json({ status: "removed" });
  });
  router.post("/alerts/:id/acknowledge", (request, response) => {
    const id = (request as RequestLike).params?.id;
    if (!id || !acknowledgeAlert(id)) {
      response.status(404).json({ error: "Alert was not found" });
      return;
    }
    response.json({ status: "acknowledged" });
  });
  router.post("/alerts/:id/silence", (request, response) => {
    const id = (request as RequestLike).params?.id;
    if (!id || !silenceAlert(id)) {
      response.status(404).json({ error: "Alert was not found" });
      return;
    }
    response.json({ status: "silenced" });
  });
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
