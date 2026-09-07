import { AlertDatabase } from "../storage/db";
import { NormalizedAlert } from "./types";

export class AlertLifecycle {
  constructor(private readonly database: AlertDatabase, private readonly transportIds: string[]) {}

  ingest(alert: NormalizedAlert, now = new Date()) {
    return this.database.ingest(alert, this.transportIds, now);
  }
}