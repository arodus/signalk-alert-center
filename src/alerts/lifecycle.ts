import { AlertDatabase } from "../storage/db";
import { NormalizedAlert } from "./types";

export class AlertLifecycle {
  constructor(
    private readonly database: AlertDatabase,
    private readonly transportIds: string[],
  ) {}

  ingest(
    alert: NormalizedAlert,
    transportIdsOrNow: string[] | Date = this.transportIds,
    now = new Date(),
  ) {
    const transportIds = Array.isArray(transportIdsOrNow)
      ? transportIdsOrNow
      : this.transportIds;
    const timestamp =
      transportIdsOrNow instanceof Date ? transportIdsOrNow : now;
    return this.database.ingest(alert, transportIds, timestamp);
  }
}
