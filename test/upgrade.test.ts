// Pure-function coverage for the self-update path (the irreversible "replace the running
// binary" command), plus a lockstep guard that the release-asset names botu downloads
// match the ones the workflows actually build.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expectedHash, RELEASE_TARGETS, releaseTargetFor, sha256 } from "../src/commands/upgrade.ts";

test("releaseTargetFor maps the three supported platforms and nothing else", () => {
  expect(releaseTargetFor("darwin", "arm64")).toBe("bun-darwin-arm64");
  expect(releaseTargetFor("darwin", "x64")).toBe("bun-darwin-x64");
  expect(releaseTargetFor("linux", "x64")).toBe("bun-linux-x64");
  expect(releaseTargetFor("linux", "arm64")).toBeUndefined();
  expect(releaseTargetFor("win32", "x64")).toBeUndefined();
});

test("expectedHash pulls the right hash out of a sha256sum manifest", () => {
  const sums = ["aaaa  botu-bun-darwin-arm64", "bbbb  botu-bun-linux-x64"].join("\n");
  expect(expectedHash(sums, "botu-bun-darwin-arm64")).toBe("aaaa");
  expect(expectedHash(sums, "botu-bun-linux-x64")).toBe("bbbb");
  expect(expectedHash(sums, "botu-bun-darwin-x64")).toBeUndefined();
});

test("expectedHash ignores blank lines and tolerates extra whitespace", () => {
  const sums = "\n  cccc   botu-bun-linux-x64  \n\n";
  expect(expectedHash(sums, "botu-bun-linux-x64")).toBe("cccc");
});

test("sha256 matches a known vector", () => {
  // echo -n '' | sha256sum
  expect(sha256(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("RELEASE_TARGETS appear verbatim in release.yml and ci.yml (asset-name lockstep)", async () => {
  const wf = join(import.meta.dir, "..", ".github", "workflows");
  const release = await readFile(join(wf, "release.yml"), "utf8");
  const ci = await readFile(join(wf, "ci.yml"), "utf8");
  for (const target of RELEASE_TARGETS) {
    expect(release).toContain(target);
    expect(ci).toContain(target);
  }
});
