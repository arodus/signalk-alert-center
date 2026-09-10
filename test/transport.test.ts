import { describe, expect, it, vi } from "vitest";
import { readResponseBody } from "../src/transports/transport";

describe("notification transport response handling", () => {
  it("does not buffer an unbounded response body", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(20_000).fill(65));
        },
        cancel,
      }),
    );

    const body = await readResponseBody(response, 8_192);

    expect(new TextEncoder().encode(body)).toHaveLength(8_192);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
