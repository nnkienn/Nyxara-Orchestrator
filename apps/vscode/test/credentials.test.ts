import { describe, expect, it } from "vitest";
import { VSCodeCredentialStore } from "../src/credentials.js";

describe("VSCodeCredentialStore", () => {
  it("uses SecretStorage only", async () => {
    const values = new Map<string, string>();
    const store = new VSCodeCredentialStore({
      get: async (key) => values.get(key),
      store: async (key, value) => { values.set(key, value); },
      delete: async (key) => { values.delete(key); },
    });
    await store.set("openai.apiKey", "test-secret");
    expect(await store.get("openai.apiKey")).toBe("test-secret");
    await store.delete("openai.apiKey");
    expect(await store.get("openai.apiKey")).toBeUndefined();
  });
});
