export function createSignalKSwitch(
  app: any,
  path: string,
  onValue: unknown,
  offValue: unknown,
) {
  return {
    async getState(): Promise<boolean | undefined> {
      const value = app.getSelfPath?.(path) ?? app.getPathValue?.(path);
      return value === undefined ? undefined : value === onValue;
    },
    async setState(on: boolean): Promise<void> {
      if (typeof app.putSelfPath !== "function")
        throw new Error("Signal K PUT API is unavailable");
      await app.putSelfPath(path, on ? onValue : offValue);
    },
  };
}
