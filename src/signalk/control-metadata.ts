import { ServerAPI } from "@signalk/server-api";
import { quietHoursPrefix } from "./quiet-hours";
import { snoozePrefix } from "./snooze";

export async function registerControlMetadata(app: ServerAPI): Promise<void> {
  if (typeof app.setDefaultMetadata !== "function") return;
  // These are persisted controls and state-change snapshots, not sensor streams.
  // Server defaults preserve explicit user metadata and avoid heartbeat traffic.
  for (const path of [
    `${quietHoursPrefix}.enabled`,
    `${snoozePrefix}.active`,
    `${snoozePrefix}.duration`,
    `${snoozePrefix}.startedAt`,
    `${snoozePrefix}.endsAt`,
  ]) {
    await app.setDefaultMetadata(path, { updateContract: "event" });
  }
}
