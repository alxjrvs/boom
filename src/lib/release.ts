// Reading boom's own GitHub releases — one function, one consumer: the `[boom]
// upgrade_on_sync` nudge. The one contract: never throw. A sync must not fail because the
// network is flaky.
const REPO = "alxjrvs/boom";

// GitHub requires a User-Agent; Accept pins the v3 JSON media type.
const GH_HEADERS = { "User-Agent": "boom", Accept: "application/vnd.github+json" };
const releasesLatestUrl = `https://api.github.com/repos/${REPO}/releases/latest`;

// Best-effort latest-version probe: returns the latest release version, or undefined on any
// error (offline, rate-limited, no release). A 5s deadline keeps a flaky network from stalling
// reconcile.
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
