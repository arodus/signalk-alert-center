import {
  AlertRecord,
  DeliveryRecord,
  Severity,
  severityRank,
} from "../alerts/types";
import {
  NotificationTransport,
  TransportContext,
  TransportResult,
} from "./transport";

export interface WyomingSayResult {
  ok: boolean;
  queued?: string[];
  suppressed?: string;
  errors?: Array<{ satellite: string; error: string }>;
}

export interface WyomingSayApi {
  version: number;
  say(options: {
    text: string;
    targets?: string[];
    voice?: string;
    priority?: "normal" | "urgent";
  }): Promise<WyomingSayResult>;
}

export interface WyomingTransportOptions {
  api: () => WyomingSayApi | undefined;
  targets?: string[];
  voice?: string;
  urgentAt?: Severity;
  definitionName?: (definitionId: string | undefined) => string | undefined;
}

const DEFAULT_TEMPLATE = "{name}. {severity}. {message}";

export function renderSpeechText(
  alert: AlertRecord,
  name: string,
  operation: DeliveryRecord["operation"],
): string {
  if (operation === "resolve") return `Cleared. ${name}.`;
  const values: Record<string, string> = {
    name,
    severity: alert.maxSeverity,
    message: alert.message?.trim() || name,
    path: alert.path,
    state: alert.currentState,
  };
  const template = alert.speechTemplate?.trim() || DEFAULT_TEMPLATE;
  const rendered = template.replace(
    /\{(name|severity|message|path|state)\}/g,
    (_match, token: string) => values[token] ?? "",
  );
  return rendered.replace(/\s+/g, " ").trim().slice(0, 500);
}

export class WyomingTransport implements NotificationTransport {
  readonly type = "wyoming";

  constructor(private readonly options: WyomingTransportOptions) {}

  async announce(
    text: string,
    priority: "normal" | "urgent",
    signal: AbortSignal,
  ): Promise<TransportResult> {
    if (signal.aborted)
      return {
        kind: "retryable",
        code: "DELIVERY_ABORTED",
        message: "Wyoming announcement was cancelled before it was queued",
      };
    const api = this.options.api();
    if (!api || api.version !== 1)
      return {
        kind: "retryable",
        code: "WYOMING_UNAVAILABLE",
        message:
          "signalk-wyoming is not running or has not published a compatible say API",
      };
    try {
      let rejectOnAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = () => reject(new Error("WYOMING_ABORTED"));
        signal.addEventListener("abort", rejectOnAbort, { once: true });
      });
      const request = api.say({
        text: text.slice(0, 500),
        priority,
        ...(this.options.targets?.length
          ? { targets: [...new Set(this.options.targets)] }
          : {}),
        ...(this.options.voice?.trim()
          ? { voice: this.options.voice.trim() }
          : {}),
      });
      const result = await Promise.race([request, aborted]).finally(() => {
        if (rejectOnAbort) signal.removeEventListener("abort", rejectOnAbort);
      });
      if (result.suppressed)
        return { kind: "success", remoteId: `suppressed:${result.suppressed}` };
      if (result.queued?.length)
        return { kind: "success", remoteId: result.queued.join(",") };
      return {
        kind: "retryable",
        code: "WYOMING_NOT_QUEUED",
        message:
          result.errors
            ?.map((item) => `${item.satellite}: ${item.error}`)
            .join("; ") || "signalk-wyoming did not queue the announcement",
      };
    } catch (error) {
      if (signal.aborted)
        return {
          kind: "retryable",
          code: "DELIVERY_ABORTED",
          message:
            "The Wyoming request timed out before queuing was confirmed; the remote queue cannot be cancelled",
        };
      return {
        kind: "retryable",
        code: "WYOMING_ERROR",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async send(
    alert: AlertRecord,
    delivery: DeliveryRecord,
    context: TransportContext,
  ): Promise<TransportResult> {
    // Defensive only: Wyoming instances do not opt into acknowledgement rows.
    // The API cannot cancel speech that has already been queued.
    if (delivery.operation === "acknowledge") return { kind: "success" };
    const name =
      this.options.definitionName?.(alert.definitionId) ?? alert.path;
    const priority =
      severityRank(alert.maxSeverity) >=
      severityRank(this.options.urgentAt ?? "alarm")
        ? "urgent"
        : "normal";
    return this.announce(
      renderSpeechText(alert, name, delivery.operation),
      priority,
      context.signal,
    );
  }
}
