export interface RetryPolicy { initialSeconds: number; maxSeconds: number; multiplier: number; jitter: number }
export function nextRetry(attempt: number, now: Date, policy: RetryPolicy, random = Math.random): Date {
  const base = Math.min(policy.maxSeconds, policy.initialSeconds * Math.pow(policy.multiplier, Math.max(0, attempt - 1)));
  const factor = 1 + (random() * 2 - 1) * policy.jitter;
  return new Date(now.getTime() + Math.max(0, base * factor) * 1000);
}