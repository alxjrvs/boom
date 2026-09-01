import { describe, expect, test } from "bun:test";
import { failureDetail, redactSecrets } from "../src/lib/proc.ts";

describe("redactSecrets", () => {
  test("replaces a secret-named env value wherever it appears", () => {
    const env = { OP_SERVICE_ACCOUNT_TOKEN: "ops_abcdef1234567890", PATH: "/usr/bin" };
    const out = redactSecrets("curl -H 'Authorization: ops_abcdef1234567890' failed", env);
    expect(out).not.toContain("ops_abcdef1234567890");
    expect(out).toContain("«redacted:OP_SERVICE_ACCOUNT_TOKEN»");
  });

  test("leaves non-secret env values alone", () => {
    const env = { PATH: "/usr/local/bin", HOME: "/Users/someone" };
    expect(redactSecrets("could not exec /usr/local/bin/thing", env)).toContain("/usr/local/bin");
  });

  test("ignores short values so ordinary output is not corrupted", () => {
    const env = { API_KEY: "abc" };
    expect(redactSecrets("abc is a fine word", env)).toBe("abc is a fine word");
  });

  test("failureDetail scrubs, and is a no-op without an env", () => {
    const env = { NPM_TOKEN: "npm_zzzzzzzzzzzz" };
    expect(failureDetail("boom: npm_zzzzzzzzzzzz", undefined, env)).toContain("«redacted:NPM_TOKEN»");
    expect(failureDetail("boom: npm_zzzzzzzzzzzz")).toContain("npm_zzzzzzzzzzzz");
  });
});
