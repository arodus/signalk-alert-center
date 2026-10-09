/* Signal K's stream wakes reads of the priority-resolved model. Sensor updates
 * never write alert history or create delivery work. */
class AlertLiveValues {
  constructor(changed, authFailed) {
    this.changed = changed;
    this.authFailed = authFailed;
    this.paths = new Set();
    this.values = new Map();
    this.timers = new Map();
    this.generation = 0;
    this.requests = new Map();
  }
  setPaths(paths) {
    const next = new Set(paths);
    if (
      next.size === this.paths.size &&
      [...next].every((path) => this.paths.has(path))
    )
      return;
    this.close();
    this.paths = next;
    if (next.size) this.connect();
  }
  connect() {
    const generation = this.generation;
    const url = new URL("/signalk/v1/stream?subscribe=none", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = (this.socket = new WebSocket(url));
    socket.onopen = () => {
      if (generation !== this.generation) return;
      socket.send(
        JSON.stringify({
          context: "vessels.self",
          subscribe: [...this.paths].map((path) => ({
            path,
            policy: "instant",
            minPeriod: 1000,
          })),
        }),
      );
      for (const path of this.paths) void this.read(path, generation);
    };
    socket.onmessage = (event) => {
      if (generation !== this.generation) return;
      let delta;
      try {
        delta = JSON.parse(event.data);
      } catch {
        return;
      }
      for (const update of delta.updates ?? []) {
        for (const { path } of update.values ?? []) {
          if (!this.paths.has(path) || this.timers.has(path)) continue;
          this.timers.set(
            path,
            setTimeout(() => {
              this.timers.delete(path);
              void this.read(path, generation);
            }, 250),
          );
        }
      }
    };
    socket.onclose = () => {
      if (generation !== this.generation) return;
      this.values.clear();
      this.changed();
      this.reconnect = setTimeout(() => this.connect(), 5000);
    };
  }
  async read(path, generation) {
    const request = {};
    this.requests.set(path, request);
    try {
      const response = await fetch(
        `/signalk/v1/api/vessels/self/${path.split(".").map(encodeURIComponent).join("/")}`,
        { credentials: "include", signal: AbortSignal.timeout(5000) },
      );
      if (
        generation !== this.generation ||
        this.requests.get(path) !== request ||
        this.socket?.readyState !== WebSocket.OPEN
      )
        return;
      if (response.status === 401 || response.status === 403) this.authFailed();
      const node = response.ok ? await response.json() : undefined;
      if (
        generation !== this.generation ||
        this.requests.get(path) !== request ||
        this.socket?.readyState !== WebSocket.OPEN
      )
        return;
      this.values.set(
        path,
        node && Number.isFinite(node.value)
          ? { value: node.value, timestamp: node.timestamp }
          : undefined,
      );
    } catch {
      if (generation !== this.generation || this.requests.get(path) !== request)
        return;
      this.values.delete(path);
    }
    this.changed();
  }
  close() {
    this.generation += 1;
    clearTimeout(this.reconnect);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
    }
    this.values.clear();
    this.requests.clear();
  }
}
