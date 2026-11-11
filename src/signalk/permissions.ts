import type { ServerAPI } from "@signalk/server-api";

/** The server exposes this strategy to plugins, but server-api does not type it yet. */
interface PutSecurityStrategy {
  shouldAllowPut?: (
    request: object,
    context: string,
    source: null,
    path: string,
  ) => boolean;
}

export function mayWritePath(
  app: ServerAPI,
  request: object,
  path: string,
): boolean {
  const strategy = (
    app as ServerAPI & { securityStrategy?: PutSecurityStrategy }
  ).securityStrategy;
  // Signal K's dummy strategy explicitly permits PUT when security is disabled.
  // A missing checker is an unsupported server, not proof that security is off.
  return (
    strategy?.shouldAllowPut?.(request, "vessels.self", null, path) === true
  );
}
