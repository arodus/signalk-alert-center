import { createHash } from "node:crypto";
import { NotifierConfig } from "../config";

export type NotificationTestCategory =
  | "success"
  | "timeout"
  | "authentication"
  | "validation"
  | "transport"
  | "remote";

export interface NotificationTestResult {
  status: "success" | "error";
  category: NotificationTestCategory;
  message: string;
  technicalDetail?: string;
  durationMs: number;
  operation: NotificationTestOperation;
  service: { id: string; type: NotifierConfig["type"] };
}

export type NotificationTestOperation = "send" | "resolve";

interface TestOptions {
  timeoutMs: number;
  fetch?: typeof fetch;
  pagerDutyEndpoint?: string;
  now?: () => number;
  operation?: NotificationTestOperation;
}

const testTitle = "TEST: Signal K Alert Center";
const testBody =
  "Manual notification-service test. This is not a vessel alert and no alert occurrence was created.";

function classifyFailure(
  status: number,
): Omit<NotificationTestResult, "durationMs" | "operation" | "service"> {
  if (status === 401 || status === 403)
    return {
      status: "error",
      category: "authentication",
      message: "The service rejected the configured credentials.",
      technicalDetail: `HTTP ${status}`,
    };
  if (status === 400 || status === 404 || status === 405 || status === 422)
    return {
      status: "error",
      category: "validation",
      message: "The service rejected the configured address or destination.",
      technicalDetail: `HTTP ${status}`,
    };
  return {
    status: "error",
    category: "remote",
    message:
      status === 408 || status === 504
        ? "The service did not complete the test in time."
        : status === 429
          ? "The service is rate limiting requests. Try again later."
          : "The service returned an unexpected response.",
    technicalDetail: `HTTP ${status}`,
  };
}

function requestFor(
  notifier: NotifierConfig,
  signal: AbortSignal,
  operation: NotificationTestOperation,
  pagerDutyEndpoint: string,
): { url: string; init: RequestInit; successMessage: string } {
  if (notifier.type === "ntfy") {
    const headers: Record<string, string> = {
      Title: testTitle,
      Priority: "2",
      Tags: "test_tube",
    };
    if (notifier.token) headers.Authorization = `Bearer ${notifier.token}`;
    return {
      url: `${notifier.server.replace(/\/$/, "")}/${encodeURIComponent(notifier.topic)}`,
      init: { method: "POST", headers, body: testBody, signal },
      successMessage: "ntfy accepted the manual test notification.",
    };
  }
  if (notifier.type === "discord")
    return {
      url: notifier.webhookUrl,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "Signal K Alert Center",
          embeds: [
            {
              title: testTitle,
              description: testBody,
              color: 0x0d7772,
            },
          ],
        }),
        signal,
      },
      successMessage: "Discord accepted the manual test notification.",
    };
  const dedupKey = `signalk-alert-center-test:${createHash("sha256")
    .update(notifier.name)
    .digest("hex")
    .slice(0, 24)}`;
  const resolving = operation === "resolve";
  return {
    url: pagerDutyEndpoint,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routing_key: notifier.routingKey,
        event_action: resolving ? "resolve" : "trigger",
        dedup_key: dedupKey,
        ...(resolving
          ? {}
          : {
              payload: {
                summary: `${testTitle}: ${notifier.name}`,
                severity: "warning",
                source: "signalk-alert-center/manual-test",
                timestamp: new Date().toISOString(),
                custom_details: { message: testBody },
              },
            }),
      }),
      signal,
    },
    successMessage: resolving
      ? "PagerDuty accepted the test-incident resolve event."
      : "PagerDuty accepted the test alert. A real test incident was opened or updated.",
  };
}

/**
 * Exercise one saved notifier without creating any plugin-side alert or
 * delivery state. Response bodies are intentionally never returned or logged.
 */
export async function testNotificationService(
  notifier: NotifierConfig,
  options: TestOptions,
): Promise<NotificationTestResult> {
  const startedAt = (options.now ?? Date.now)();
  const operation = options.operation ?? "send";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  timeout.unref?.();
  const service = { id: notifier.name, type: notifier.type };
  const finish = (
    result: Omit<
      NotificationTestResult,
      "durationMs" | "operation" | "service"
    >,
  ): NotificationTestResult => ({
    ...result,
    durationMs: Math.max(0, (options.now ?? Date.now)() - startedAt),
    operation,
    service,
  });
  try {
    const request = requestFor(
      notifier,
      controller.signal,
      operation,
      options.pagerDutyEndpoint ?? "https://events.pagerduty.com/v2/enqueue",
    );
    const response = await (options.fetch ?? fetch)(request.url, request.init);
    if (!response.ok) return finish(classifyFailure(response.status));
    return finish({
      status: "success",
      category: "success",
      message: request.successMessage,
    });
  } catch (error) {
    if (controller.signal.aborted)
      return finish({
        status: "error",
        category: "timeout",
        message: "The service test timed out.",
        technicalDetail: `Timeout after ${options.timeoutMs} ms`,
      });
    const code =
      error && typeof error === "object" && "cause" in error
        ? (error.cause as { code?: unknown } | undefined)?.code
        : undefined;
    return finish({
      status: "error",
      category: "transport",
      message:
        "The service could not be reached. Check its address, DNS, and network connection.",
      ...(typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
        ? { technicalDetail: code }
        : {}),
    });
  } finally {
    clearTimeout(timeout);
  }
}
