// `boom upgrade` — self-update: fetch the latest GitHub release for this platform,
// verify its checksum, and atomically replace the running binary in place. The TS twin
// of install.sh's download path (same release assets, same macOS ad-hoc re-sign), so a
// machine that bootstrapped via the curl-pipe can keep current without re-running it.
import { basename, dirname, join } from "node:path";
import { buildCommand } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { colorEnabled } from "../lib/color.ts";
import { chmod, rename, rm } from "../lib/fs.ts";
import { runArgv } from "../lib/proc.ts";
import { Reporter } from "../lib/reporter.ts";
import { VERSION } from "../lib/version.ts";

const REPO = "alxjrvs/boom";

// The Bun `--target` suffixes boom ships. These are exactly the targets release.yml
// cross-compiles and ci.yml smoke-builds; the lockstep is guarded by a test that greps
// both workflows (test/upgrade.test.ts), so a renamed asset can't silently break
// `boom upgrade` / install.sh.
export const RELEASE_TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
] as const;

// process.platform/arch → the release-asset suffix install.sh maps `uname` to.
export function releaseTargetFor(platform: string, arch: string): string | undefined {
  switch (`${platform}/${arch}`) {
    case "darwin/arm64":
      return "bun-darwin-arm64";
    case "darwin/x64":
      return "bun-darwin-x64";
    case "linux/x64":
      return "bun-linux-x64";
    case "linux/arm64":
      return "bun-linux-arm64";
    default:
      return undefined;
  }
}

// Stage the downloaded bytes beside the running binary (same directory → same filesystem,
// so the swap can be an atomic rename). Returns the staged path. Split out from the swap
// so the irreversible replace-the-running-binary step is unit-testable without a live
// download (test/upgrade.test.ts drives these two against a throwaway file).
export async function stageBinary(self: string, bin: Uint8Array): Promise<string> {
  const staged = join(dirname(self), `.boom.upgrade.${process.pid}`);
  await Bun.write(staged, bin);
  await chmod(staged, 0o755);
  return staged;
}

// Swap the staged binary into place. `rename(2)` over the running executable is safe on
// Unix — the live process keeps the old inode. Clean up the staging file if the rename
// itself fails, so a failed upgrade never leaves a stray `.boom.upgrade.*` behind.
export async function swapInto(self: string, staged: string): Promise<void> {
  try {
    await rename(staged, self);
  } catch (e) {
    await rm(staged, { force: true });
    throw e;
  }
}

function releaseTarget(): string | undefined {
  return releaseTargetFor(process.platform, process.arch);
}

interface Release {
  readonly tag: string; // e.g. "v0.0.3"
  readonly version: string; // tag without the leading "v"
}

async function latestRelease(): Promise<Release> {
  // GitHub requires a User-Agent; Accept pins the v3 JSON media type.
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "User-Agent": "boom-upgrade", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { tag_name?: string };
  const tag = body.tag_name;
  if (!tag) throw new Error("release has no tag_name");
  return { tag, version: tag.replace(/^v/, "") };
}

// Best-effort latest-version probe for the `[boom] upgrade_check_on_sync` nudge: returns the
// latest release version, or undefined on any error (offline, rate-limited, no release) —
// never throws, so a sync-time check can't fail the sync. A 5s deadline keeps a flaky
// network from stalling reconcile.
export async function fetchLatestVersion(): Promise<string | undefined> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "User-Agent": "boom-upgrade", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { tag_name?: string };
    return body.tag_name?.replace(/^v/, "") || undefined;
  } catch {
    return undefined;
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { "User-Agent": "boom-upgrade" } });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
  return new Uint8Array(await res.arrayBuffer());
}

export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// Pull the expected hash for `asset` out of a `sha256sum`-format manifest
// (`<hex>  <name>` per line). Undefined if the asset isn't listed.
export function expectedHash(sums: string, asset: string): string | undefined {
  for (const line of sums.split("\n")) {
    const [hash, ...rest] = line.trim().split(/\s+/);
    if (rest.join(" ") === asset && hash) return hash;
  }
  return undefined;
}

type UpgradeFlags = { force?: boolean; check?: boolean };

export const upgradeCommand = buildCommand<UpgradeFlags, [], BoomContext>({
  docs: { brief: "Fetch the latest release and replace the running binary in place" },
  parameters: {
    flags: {
      check: { kind: "boolean", optional: true, brief: "Report the latest version; change nothing" },
      force: { kind: "boolean", optional: true, brief: "Reinstall even if already up to date" },
    },
  },
  async func(flags) {
    const report = new Reporter(this.process.stdout, this.process.stderr, colorEnabled(this.env));
    report.header(`boom upgrade (current ${VERSION})`);

    const target = releaseTarget();
    if (!target) {
      report.fail(`unsupported platform ${process.platform}/${process.arch}`);
      this.process.exitCode = 1;
      return;
    }

    // The running executable. Refuse if we weren't launched as the compiled `boom`
    // binary (e.g. `bun run src/index.ts` during dev → execPath is bun itself) so we
    // never clobber the runtime.
    const self = process.execPath;
    if (basename(self) !== "boom") {
      report.fail(`not a compiled boom binary (${self}); upgrade only replaces an installed boom`);
      this.process.exitCode = 1;
      return;
    }

    let release: Release;
    try {
      release = await latestRelease();
    } catch (err) {
      report.fail(`could not resolve latest release: ${(err as Error).message}`);
      this.process.exitCode = 1;
      return;
    }

    if (release.version === VERSION && !flags.force) {
      report.ok(`already on the latest version (${VERSION})`);
      return;
    }
    if (flags.check) {
      report.note(`latest is ${release.version} (you have ${VERSION}) — run \`boom upgrade\` to install`);
      return;
    }

    const asset = `boom-${target}`;
    const base = `https://github.com/${REPO}/releases/download/${release.tag}`;
    report.plan(`downloading ${asset} ${release.tag}`);

    let bin: Uint8Array;
    let sums: string;
    try {
      [bin, sums] = await Promise.all([
        fetchBytes(`${base}/${asset}`),
        fetchBytes(`${base}/SHA256SUMS`).then((b) => new TextDecoder().decode(b)),
      ]);
    } catch (err) {
      report.fail((err as Error).message);
      this.process.exitCode = 1;
      return;
    }

    const want = expectedHash(sums, asset);
    if (!want) {
      report.fail(`SHA256SUMS has no entry for ${asset}`);
      this.process.exitCode = 1;
      return;
    }
    const got = sha256(bin);
    if (got !== want) {
      report.fail(`checksum mismatch for ${asset} — refusing to install (want ${want}, got ${got})`);
      this.process.exitCode = 1;
      return;
    }
    report.ok("checksum verified");

    // Stage beside the target (same filesystem → rename is atomic) then swap. `staged` is
    // declared out here so the catch can clean it up no matter where the flow threw —
    // stageBinary's own chmod, codesign, or the swap — never leaving a stray `.boom.upgrade.*`.
    let staged: string | undefined;
    try {
      staged = await stageBinary(self, bin);

      // macOS release binaries are signed on a real macOS host, so the download should
      // already verify. Only re-sign ad-hoc as a fallback when it doesn't — re-signing a
      // Developer-ID binary would clobber its signature and undo notarization. No-op on
      // Linux. (Mirrors install.sh.)
      if (process.platform === "darwin") {
        const verified =
          runArgv(["codesign", "--verify", "--strict", staged], this.env, { quietStdout: true }).code === 0;
        if (!verified) {
          const { code } = runArgv(["codesign", "--force", "--sign", "-", staged], this.env, {
            quietStdout: true,
          });
          if (code !== 0)
            report.warn(
              "ad-hoc re-sign failed — if boom is killed on launch, re-run after `xcode-select --install`",
            );
        }
      }

      await swapInto(self, staged);
    } catch (err) {
      if (staged) await rm(staged, { force: true });
      report.fail(`install failed: ${(err as Error).message}`);
      this.process.exitCode = 1;
      return;
    }

    report.ok(`upgraded ${VERSION} → ${release.version}  (${self})`);
  },
});
