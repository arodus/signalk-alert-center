export interface InternetProbeConfig {
  url: string;
  timeoutMs?: number;
}

export function createInternetProbe(
  config: InternetProbeConfig,
): () => Promise<boolean> {
  return async () => {
    const controller = new AbortController();
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
    }
  };
}
