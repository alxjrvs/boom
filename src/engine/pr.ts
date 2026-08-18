// The pull-request half of `boom source push`. Kept apart from push.ts so that file stays
// about orchestration and this one owns every assumption about GitHub: how to recognize a
// GitHub remote, what to name the branch, and how to drive `gh`.
//
// Why `gh` rather than the REST API: boom already shells out for every other external tool
// (brew/mise/git), and `gh` carries the user's existing auth — including SSO-authorized and
// enterprise hosts — so PR mode inherits whatever already works in their shell instead of
// inventing a second credential path for boom to get wrong.
import type { Env } from "../lib/paths.ts";
import { type CaptureResult, captureArgvAsync, hasCommand } from "../lib/proc.ts";

// Recognizes the three spellings `git remote get-url` can return for a GitHub repo:
// scp-style (git@github.com:owner/repo.git), https, and ssh:// URLs. Anything else —
// GitLab, a bare path, a local fixture — yields undefined, which is how PR mode decides
// it does not apply and the caller falls back to a direct push.
export function githubSlug(url: string): string | undefined {
  const m = url.match(
    /^(?:git@github\.com:|(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\/)(.+?)(?:\.git)?\/?$/,
  );
  const slug = m?.[1];
  // owner/repo exactly — a longer path is some other github.com URL, not a clone ref.
  return slug && /^[^/]+\/[^/]+$/.test(slug) ? slug : undefined;
}

// A branch name derived from the commit, not from a clock: `boom/<subject-slug>-<sha>`.
// The short sha is what makes re-running safe — the same commit always resolves to the
// same branch, so a retry after a failed `gh` call reuses the ref it already pushed
// instead of littering the remote with near-duplicates.
export function branchNameFor(subject: string, sha: string): string {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `boom/${slug || "config"}-${sha.slice(0, 7)}`;
}

export function ghAvailable(env: Env): boolean {
  return hasCommand("gh", env);
}

export interface PrResult {
  readonly code: number;
  readonly url?: string;
  readonly stderr: string;
}

// `--head` is passed explicitly because the branch is deliberately *not* checked out
// (see pushHeadToBranchAsync) — without it `gh` would infer the head from the current
// branch, which is the default branch, and refuse.
export async function createPullRequest(
  dir: string,
  opts: { readonly branch: string; readonly base: string; readonly title: string; readonly body: string },
  env: Env,
): Promise<PrResult> {
  const r = await captureArgvAsync(
    [
      "gh",
      "pr",
      "create",
      "--head",
      opts.branch,
      "--base",
      opts.base,
      "--title",
      opts.title,
      "--body",
      opts.body,
    ],
    // GH_PROMPT_DISABLED keeps `gh` from blocking on a TTY question when it is
    // unauthenticated: it fails fast with a message boom can report instead of hanging
    // a non-interactive run (a timer, a CI step) forever.
    { ...env, GH_PROMPT_DISABLED: "1" },
    { cwd: dir },
  );
  return { code: r.code, url: prUrl(r), stderr: r.stderr };
}

// `gh pr create` prints the PR URL as its last stdout line. It also prints it on the
// "already exists" *error* path, which is why stderr is scanned too — a retry should
// report the existing PR rather than looking like it produced nothing.
function prUrl(r: CaptureResult): string | undefined {
  const m = `${r.stdout}\n${r.stderr}`.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/g);
  return m?.[m.length - 1];
}

// Auto-merge is a *request*, not a merge: GitHub still holds the PR until required checks
// pass. That is the point — it closes the loop without ever merging something unverified,
// so it is safe to offer as a flag on a command whose whole job is unattended convenience.
export function enableAutoMerge(dir: string, pr: string, env: Env): Promise<CaptureResult> {
  return captureArgvAsync(
    ["gh", "pr", "merge", pr, "--auto", "--squash"],
    { ...env, GH_PROMPT_DISABLED: "1" },
    {
      cwd: dir,
    },
  );
}
