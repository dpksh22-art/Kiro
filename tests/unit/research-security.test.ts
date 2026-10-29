import { describe, expect, it } from "vitest";
import { assertPublicUrl } from "@/src/modules/research/http";

describe("research SSRF guard", () => {
  it.each(["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data", "http://192.0.2.1/", "http://198.18.0.1/", "http://203.0.113.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[64:ff9b:1::7f00:1]/", "http://[3fff::1]/", "http://[2001:db8::1]/", "http://[2001:100::1]/", "http://[2606:4700:4700::1111]/", "file:///etc/passwd", "http://user:pass@example.com/"])("blocks restricted URL %s", async (url) => {
    await expect(assertPublicUrl(url)).rejects.toThrow();
  });
  it("allows a public HTTPS origin", async () => {
    await expect(assertPublicUrl("https://example.com/")).resolves.toMatchObject({ hostname: "example.com" });
  });
});
