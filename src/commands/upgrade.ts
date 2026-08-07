// `boom upgrade` — self-update: fetch the latest GitHub release for this platform,
// verify its checksum, and atomically replace the running binary in place. The TS twin
// of install.sh's download path (same release assets, same macOS ad-hoc re-sign), so a
// machine that bootstrapped via the curl-pipe can keep current without re-running it.
import { basename, dirname, join } from "node:path";
import { buildCommand } from "@stricli/core";
import type { BoomContext } from "../context.ts";
import { chmod, rename, rm } from "../lib/fs.ts";
import type { Env } from "../lib/paths.ts";
import { runArgv } from "../lib/proc.ts";
// The release-metadata fetchers live in lib/ so the engine's sync-time upgrade check can reach
// them without importing a command; `REPO` comes back here for the asset/checksum URLs.
import { latestRelease, REPO, type Release } from "../lib/release.ts";
import { bandsReporter, type Reporter } from "../lib/reporter.ts";
import { VERSION } from "../lib/version.ts";

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

// The one rendering of "which version am I moving between" — used by both the up-front banner and
// the closing verdict, so the two can never disagree about the target (or about the `v` prefix,
// which the raw values don't carry).
export function versionSpan(from: string, to: string): string {
  return `v${from} → v${to}`;
}

type UpgradeFlags = { force?: boolean; check?: boolean };

// The upgrade flow, returning the verdict band's outcome text on success (e.g. "v0.14.0 → v0.15.0")
// or undefined on any failure — where it has already reported the reason via report.fail(). The
// caller turns that into `▎ UPGRADE...COMPLETE!` / `...FAILED!` through report.finish().
async function runUpgrade(flags: UpgradeFlags, report: Reporter, env: Env): Promise<string | undefined> {
  const target = releaseTarget();
  if (!target) {
    report.fail(`unsupported platform ${process.platform}/${process.arch}`);
    return;
  }

  // The running executable. Refuse if we weren't launched as the compiled `boom` binary
  // (e.g. `bun run src/index.ts` during dev → execPath is bun itself) so we never clobber the runtime.
  const self = process.execPath;
  if (basename(self) !== "boom") {
    report.fail(`not a compiled boom binary (${self}); upgrade only replaces an installed boom`);
    return;
  }

  let release: Release;
  try {
    release = await report.spin("checking for the latest release", () => latestRelease());
  } catch (err) {
    report.fail(`could not resolve latest release: ${(err as Error).message}`);
    return;
  }

  if (release.version === VERSION && !flags.force) return `already on the latest (v${VERSION})`;
  if (flags.check) return `latest is v${release.version} — you have v${VERSION}`;

  // Announce the target the moment it's known, as an *eager* banner — a persistent line printed
  // before the multi-second download, rather than a detail line buffered into the section band
  // that only closes after it. "What am I being upgraded to?" is the one thing worth having on
  // screen while the download runs, and the band's own detail is too late to answer it.
  report.header(`upgrading ${versionSpan(VERSION, release.version)}`, true);

  // Open a band so the install milestones (checksum verified) land as a summary; the live in-flight
  // narration is the sequence of spinner labels (checking → downloading → installing), each of
  // which also names the target so a non-interactive log records it too. Labelled "Install" rather
  // than "Upgrade" so it doesn't read as a duplicate of the banner above and the verdict below.
  report.header("Install");

  const asset = `boom-${target}`;
  const base = `https://github.com/${REPO}/releases/download/${release.tag}`;

  let bin: Uint8Array;
  let sums: string;
  try {
    [bin, sums] = await report.spin(`downloading ${release.tag} (${asset})`, () =>
      Promise.all([
        fetchBytes(`${base}/${asset}`),
        fetchBytes(`${base}/SHA256SUMS`).then((b) => new TextDecoder().decode(b)),
      ]),
    );
  } catch (err) {
    report.fail((err as Error).message);
    return;
  }

  const want = expectedHash(sums, asset);
  if (!want) {
    report.fail(`SHA256SUMS has no entry for ${asset}`);
    return;
  }
  const got = sha256(bin);
  if (got !== want) {
    report.fail(`checksum mismatch for ${asset} — refusing to install (want ${want}, got ${got})`);
    return;
  }
  report.ok(`checksum verified for ${release.tag}`);

  // Stage beside the target (same filesystem → rename is atomic) then swap. `staged` is declared
  // out here so the catch can clean it up no matter where the flow threw — stageBinary's own chmod,
  // codesign, or the swap — never leaving a stray `.boom.upgrade.*`.
  let staged: string | undefined;
  try {
    await report.spin(`installing ${release.tag}`, async () => {
      staged = await stageBinary(self, bin);

      // macOS release binaries are signed on a real macOS host, so the download should already
      // verify. Only re-sign ad-hoc as a fallback when it doesn't — re-signing a Developer-ID binary
      // would clobber its signature and undo notarization. No-op on Linux. (Mirrors install.sh.)
      if (process.platform === "darwin") {
        const verified =
          runArgv(["codesign", "--verify", "--strict", staged], env, { quietStdout: true }).code === 0;
        if (!verified) {
          const { code } = runArgv(["codesign", "--force", "--sign", "-", staged], env, {
            quietStdout: true,
          });
          if (code !== 0)
            report.warn(
              "ad-hoc re-sign failed — if boom is killed on launch, re-run after `xcode-select --install`",
            );
        }
      }

      await swapInto(self, staged);
    });
  } catch (err) {
    if (staged) await rm(staged, { force: true });
    report.fail(`install failed: ${(err as Error).message}`);
    return;
  }

  return versionSpan(VERSION, release.version);
}

export const upgradeCommand = buildCommand<UpgradeFlags, [], BoomContext>({
  docs: { brief: "Fetch the latest release and replace the running binary in place" },
  parameters: {
    flags: {
      check: { kind: "boolean", optional: true, brief: "Report the latest version; change nothing" },
      force: { kind: "boolean", optional: true, brief: "Reinstall even if already up to date" },
    },
  },
  async func(flags) {
    // Dense bands (the default write path): the grey setup band, the download/checksum detail
    // lines, and a verdict band carrying the outcome (e.g. "v0.14.0 → v0.15.0").
    const report = bandsReporter(this.process, this.env, "upgrade", {
      setup: "COMMUNING WITH THE SOURCE…",
    });
    const meta = await runUpgrade(flags, report, this.env);
    this.process.exitCode = report.finish({ ok: "upgrade done", fail: (f) => `${f} failure(s)`, meta });
  },
});
