import { isCoreAlert } from "./core-alerts";
import { ServerAPI } from "@signalk/server-api";
import {
  generatedZoneMessage,
  isZoneMessage,
  UnitMetadata,
} from "../../public/units";
import { normalizeNotification } from "../alerts/normalize";
import { MessageSample } from "../alerts/types";
import { SignalKNotificationInput } from "./notifications";

export function captureMessageSample(
  app: ServerAPI,
  entry: SignalKNotificationInput,
): MessageSample | undefined {
  const { message } = normalizeNotification(entry.path, entry.value);
  if (!message) return undefined;
  const core =
    entry.kind === "core" && isCoreAlert(entry.value) ? entry.value : undefined;
  if (core?.$source === "signalk-alert-rules") return undefined;
  const path = core
    ? core.references?.[0]
    : entry.path.replace(/^notifications\./, "");
  if (!path) return undefined;
  const sample: MessageSample = {
    message,
    capturedAt: new Date().toISOString(),
  };
  try {
    // Zone notifications describe the priority-resolved path, not the zone plugin's source.
    const node = app.getSelfPath(path) as
      { value?: unknown; meta?: { units?: unknown } } | undefined;
    const metadata = {
      ...app.getMetadata?.(`vessels.self.${path}`),
      ...node?.meta,
      path,
    } as UnitMetadata;
    if (!isZoneMessage(message, metadata)) return undefined;
    const generated = generatedZoneMessage(message, metadata);
    if (generated)
      sample.generatedZone = {
        name: generated.name,
        lower: generated.lower,
        upper: generated.upper,
      };
    const units = metadata.units;
    if (typeof node?.value === "number" && Number.isFinite(node.value))
      sample.value = node.value;
    if (typeof units === "string") sample.units = units;
  } catch {
    // Missing readings must not prevent durable ingestion.
    if (!isZoneMessage(message)) return undefined;
  }
  return sample;
}
