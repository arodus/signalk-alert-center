import type { CoreAlert } from "../../src/signalk/core-alerts";

export const coreFixture = (patch: Partial<CoreAlert> = {}): CoreAlert => ({
  id: "core-1",
  path: "bilge.highWater",
  $source: "bilge-sensor",
  priority: "alarm",
  state: "unacknowledged",
  condition: true,
  latching: false,
  silenced: false,
  message: "Bilge water high",
  sourceOnline: true,
  stale: false,
  raisedAt: "2026-10-25T08:00:00.000Z",
  stateChangedAt: "2026-10-25T08:00:00.000Z",
  lastSourceUpdate: "2026-10-25T08:00:00.000Z",
  ...patch,
});
