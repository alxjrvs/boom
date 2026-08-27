// Reading boom's own GitHub releases. Two consumers with opposite failure contracts —
// `boom upgrade` (throws, the user asked for it) and the `[boom] upgrade_on_sync`
// nudge (never throws, a sync must not fail on a flaky network) — so both live here rather
// than in `commands/upgrade.ts`: the engine used to reach *up* into commands for the second
// one through a dynamic import that was only ever hiding the layer inversion from tsc.
export const REPO = "alxjrvs/boom";

// GitHub requires a User-Agent; Accept pins the v3 JSON media type.
const GH_HEADERS = { "User-Agent": "boom-upgrade", Accept: "application/vnd.github+json" };
const releasesLatestUrl = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface Release {
  readonly tag: string; // e.g. "v0.0.3"
  readonly version: string; // tag without the leading "v"
}

export async function latestRelease(): Promise<Release> {
  const res = await fetch(releasesLatestUrl, { headers: GH_HEADERS });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { tag_name?: string };
  const tag = body.tag_name;
  if (!tag) throw new Error("release has no tag_name");
  return { tag, version: tag.replace(/^v/, "") };
}

// Best-effort latest-version probe for the `[boom] upgrade_on_sync` nudge: returns the
// latest release version, or undefined on any error (offline, rate-limited, no release) —
// never throws, so a sync-time check can't fail the sync. A 5s deadline keeps a flaky
// network from stalling reconcile.
export async function fetchLatestVersion(): Promise<string | undefined> {
  try {
    const res = await fetch(releasesLatestUrl, { headers: GH_HEADERS, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { tag_name?: string };
    return body.tag_name?.replace(/^v/, "") || undefined;
  } catch {
    return undefined;
  }
}
