// Pure-function coverage for the self-update path (the irreversible "replace the running
// binary" command), plus a lockstep guard that the release-asset names boom downloads
// match the ones the workflows actually build.
import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectedHash,
  RELEASE_TARGETS,
  releaseTargetFor,
  sha256,
  stageBinary,
  swapInto,
} from "../src/commands/upgrade.ts";
import { pathExists } from "../src/lib/fs.ts";

test("releaseTargetFor maps the four supported platforms and nothing else", () => {
  expect(releaseTargetFor("darwin", "arm64")).toBe("bun-darwin-arm64");
  expect(releaseTargetFor("darwin", "x64")).toBe("bun-darwin-x64");
  expect(releaseTargetFor("linux", "x64")).toBe("bun-linux-x64");
  expect(releaseTargetFor("linux", "arm64")).toBe("bun-linux-arm64");
  expect(releaseTargetFor("win32", "x64")).toBeUndefined();
  expect(releaseTargetFor("darwin", "ia32")).toBeUndefined();
});

test("expectedHash pulls the right hash out of a sha256sum manifest", () => {
  const sums = ["aaaa  boom-bun-darwin-arm64", "bbbb  boom-bun-linux-x64"].join("\n");
  expect(expectedHash(sums, "boom-bun-darwin-arm64")).toBe("aaaa");
  expect(expectedHash(sums, "boom-bun-linux-x64")).toBe("bbbb");
  expect(expectedHash(sums, "boom-bun-darwin-x64")).toBeUndefined();
});

test("expectedHash ignores blank lines and tolerates extra whitespace", () => {
  const sums = "\n  cccc   boom-bun-linux-x64  \n\n";
  expect(expectedHash(sums, "boom-bun-linux-x64")).toBe("cccc");
});

test("sha256 matches a known vector", () => {
  // echo -n '' | sha256sum
  expect(sha256(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("stageBinary + swapInto atomically replace the target binary in place", async () => {
  // The irreversible half of `boom upgrade` — extracted so it's testable without a live
  // download. Prove: staged bytes land, the swap replaces the target, staging is cleaned.
  const dir = await mkdtemp(join(tmpdir(), "boom-upg-"));
  const self = join(dir, "boom");
  await writeFile(self, "OLD");
  await chmod(self, 0o755);

  const staged = await stageBinary(self, new TextEncoder().encode("NEW"));
  expect(await pathExists(staged)).toBe(true);
  expect((await stat(staged)).mode & 0o111).toBeGreaterThan(0); // executable

  await swapInto(self, staged);
  expect(await readFile(self, "utf8")).toBe("NEW"); // swapped in
  expect(await pathExists(staged)).toBe(false); // staging cleaned up
});

test("swapInto cleans up the staged file when the rename fails", async () => {
  // A swap whose target directory can't be written must not leave a stray `.boom.upgrade.*`.
  const dir = await mkdtemp(join(tmpdir(), "boom-upg-"));
  const staged = await stageBinary(join(dir, "boom"), new TextEncoder().encode("NEW"));
  // Rename into a path whose parent is a file, not a directory → ENOTDIR.
  const badTarget = join(staged, "nope", "boom");
  let threw = false;
  try {
    await swapInto(badTarget, staged);
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  expect(await pathExists(staged)).toBe(false); // cleaned up despite the failure
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
