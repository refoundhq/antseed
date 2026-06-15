import { describe, expect, it } from "vitest";

import { readBodyWithLimit } from "../src/discovery/verification-utils.js";

function textFallbackResponse(text: string): Response {
  return {
    headers: new Headers(),
    body: null,
    text: async () => text,
  } as unknown as Response;
}

describe("verification utils", () => {
  it("counts bytes in the non-streaming body fallback", async () => {
    await expect(readBodyWithLimit(textFallbackResponse("é".repeat(2_049)), 4_096))
      .rejects.toThrow("Proof body exceeds 4096 bytes");
  });

  it("accepts non-streaming bodies within the byte limit", async () => {
    await expect(readBodyWithLimit(textFallbackResponse("é".repeat(2_048)), 4_096))
      .resolves.toBe("é".repeat(2_048));
  });
});
