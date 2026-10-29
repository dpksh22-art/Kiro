import { describe, expect, it } from "vitest";
import { parseNdjson, parseSse } from "@/src/modules/gateway/streaming";

describe("provider stream parsing", () => {
  it("parses SSE split across chunks", async () => {
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode("event: delta\ndata: {\"text\":")); controller.enqueue(encoder.encode("\"hello\"}\n\ndata: [DONE]\n\n")); controller.close(); } }));
    const values = [];
    for await (const item of parseSse(response)) values.push(item);
    expect(values).toEqual([{ event: "delta", data: "{\"text\":\"hello\"}" }, { event: undefined, data: "[DONE]" }]);
  });

  it("parses newline-delimited JSON", async () => {
    const response = new Response('{"a":1}\n{"b":2}\n');
    const values = [];
    for await (const item of parseNdjson(response)) values.push(item);
    expect(values).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
