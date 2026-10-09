import { ServerAPI } from "@signalk/server-api";
import { isZoneMessage } from "../../public/units";
import { normalizeNotification } from "../alerts/normalize";
import { MessageSample } from "../alerts/types";
import { SignalKNotificationInput } from "./notifications";

export function captureMessageSample(
  app: ServerAPI,
  entry: SignalKNotificationInput,
): MessageSample | undefined {
  const { message } = normalizeNotification(entry.path, entry.value);
  if (!message || !isZoneMessage(message)) return undefined;
  const path = entry.path.replace(/^notifications\./, "");
  const sample: MessageSample = {
    message,
    capturedAt: new Date().toISOString(),
  };
  try {
    // Zone notifications describe the priority-resolved path, not the zone plugin's source.
    const node = app.getSelfPath(path) as
      { value?: unknown; meta?: { units?: unknown } } | undefined;
    const units =
      node?.meta?.units ?? app.getMetadata?.(`vessels.self.${path}`)?.units;
    if (typeof node?.value === "number" && Number.isFinite(node.value))
      sample.value = node.value;
    if (typeof units === "string") sample.units = units;
  } catch {
    // Missing readings must not prevent durable ingestion.
  }
  return sample;
}
