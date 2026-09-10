export interface InternetProbeConfig {
  url: string;
  timeoutMs?: number;
}

export function createInternetProbe(
  config: InternetProbeConfig,
): (signal?: AbortSignal) => Promise<boolean> {
  return async (signal?: AbortSignal) => {
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", stop, { once: true });
    const timeout = setTimeout(
      () => controller.abort(),
      config.timeoutMs ?? 10_000,
    );
    try {
      const response = await fetch(config.url, {
        method: "HEAD",
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
    }
  };
}
