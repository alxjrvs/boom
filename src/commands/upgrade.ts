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
export const RELEASE_TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64"] as const;

// process.platform/arch → the release-asset suffix install.sh maps `uname` to.
export function releaseTargetFor(platform: string, arch: string): string | undefined {
  switch (`${platform}/${arch}`) {
    case "darwin/arm64":
      return "bun-darwin-arm64";
    case "darwin/x64":
      return "bun-darwin-x64";
    case "linux/x64":
      return "bun-linux-x64";
    default:
      return undefined;
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

    // Stage beside the target (same filesystem → rename is atomic) then swap. Renaming
    // over the running executable is safe on Unix: the live process keeps the old inode.
    const dir = dirname(self);
    const staged = join(dir, `.boom.upgrade.${release.version}`);
    try {
      await Bun.write(staged, bin);
      await chmod(staged, 0o755);

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

      await rename(staged, self);
    } catch (err) {
      await rm(staged, { force: true });
      report.fail(`install failed: ${(err as Error).message}`);
      this.process.exitCode = 1;
      return;
    }

    report.ok(`upgraded ${VERSION} → ${release.version}  (${self})`);
  },
});
