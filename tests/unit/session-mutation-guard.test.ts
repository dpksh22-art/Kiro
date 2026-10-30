import { describe, expect, it } from "vitest";
import { isAllowedApiRequest } from "@/src/core/session";

function mutation(headers: Record<string, string>, body: BodyInit | null = "{}"): Request {
  return new Request("http://localhost:3000/api/v1/projects", { method: "POST", headers, body });
}

describe("custom API mutation CSRF boundary", () => {
  const browser = { origin: "http://localhost:3000", "sec-fetch-site": "same-origin", "content-type": "application/json" };
  it("accepts exact same-origin browser JSON", () => expect(isAllowedApiRequest(mutation(browser))).toBe(true));
  it("rejects cross-site and sibling same-site browser requests", () => {
    expect(isAllowedApiRequest(mutation({ ...browser, origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isAllowedApiRequest(mutation({ ...browser, origin: "http://sibling.localhost:3000", "sec-fetch-site": "same-site" }))).toBe(false);
  });
  it("rejects browser requests with missing or wrong origin and simple text JSON", () => {
    expect(isAllowedApiRequest(mutation({ "sec-fetch-site": "same-origin", "content-type": "application/json" }))).toBe(false);
    expect(isAllowedApiRequest(mutation({ ...browser, origin: "http://localhost:3001" }))).toBe(false);
    expect(isAllowedApiRequest(mutation({ ...browser, "content-type": "text/plain" }))).toBe(false);
  });
  it("allows an explicit artifact media-type exception and a headerless trusted server client", () => {
    expect(isAllowedApiRequest(mutation({ ...browser, "content-type": "application/pdf" }, "pdf"), { allowedMutationContentTypes: ["application/pdf"] })).toBe(true);
    expect(isAllowedApiRequest(mutation({ "content-type": "application/json" }))).toBe(true);
  });
});
