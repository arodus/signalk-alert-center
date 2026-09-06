import { AlertDatabase } from "../storage/db";
import { IngestOptions, NormalizedAlert } from "./types";

export class AlertLifecycle {
  constructor(
    private readonly database: AlertDatabase,
    private readonly transportIds: string[],
  ) {}

  ingest(
    alert: NormalizedAlert,
    transportIdsOrNow: string[] | Date = this.transportIds,
    now = new Date(),
    options: IngestOptions = {},
  ) {
    const transportIds = Array.isArray(transportIdsOrNow)
      ? transportIdsOrNow
      : this.transportIds;
    const timestamp =
      transportIdsOrNow instanceof Date ? transportIdsOrNow : now;
    return this.database.ingest(alert, transportIds, timestamp, options);
  }

  processDueActivations(now = new Date()) {
    return this.database.processDueActivations(now);
  }
}
