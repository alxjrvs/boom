// The test sandbox's own contract. Worth pinning because the thing it guarantees — that a suite
// cannot reach the real machine — is invisible when it works and silent when it breaks: a sandbox
// missing one variable still passes every test it hosts, right up until someone's global git
// config or a stray $HOME makes CI disagree with a laptop.
import { expect, test } from "bun:test";
import { makeSandbox } from "./support/sandbox.ts";

test("the sandbox redirects every path the engine could reach the real machine through", async () => {
  const sb = await makeSandbox('[[section]]\nname = "s"\n');

  // HOME and the state dir must point inside the throwaway base, never at the real ones.
  expect(sb.env.HOME).toBe(sb.home);
  expect(sb.home.startsWith(sb.base)).toBe(true);
  expect(sb.env.XDG_STATE_HOME?.startsWith(sb.base)).toBe(true);
  expect(sb.env.BOOM_CONFIG).toBe(sb.repo);
  expect(sb.repo.startsWith(sb.base)).toBe(true);

  // The one that drifted. A sandboxed HOME covers ~/.gitconfig but NOT /etc/gitconfig, so this
  // is the half that has to be set explicitly — and the half that is easy to leave out. The
  // global config is pinned off too, and a commit identity supplied, so the engine's own git
  // never depends on the developer's.
  expect(sb.env.GIT_CONFIG_NOSYSTEM).toBe("1");
  expect(sb.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(sb.env.GIT_COMMITTER_EMAIL).toBeDefined();

  // Deterministic output for byte-comparing assertions.
  expect(sb.env.NO_COLOR).toBe("1");
});

test("emptyPath points PATH at a directory with no tools in it", async () => {
  const withTools = await makeSandbox('[[section]]\nname = "s"\n');
  expect(withTools.env.PATH).toBe(process.env.PATH);

  const without = await makeSandbox('[[section]]\nname = "s"\n', { emptyPath: true });
  expect(without.env.PATH).toBe(`${without.base}/empty-bin`);
  expect(without.env.PATH).not.toBe(process.env.PATH);
});

test("caller env is merged last, so a suite can override a default", async () => {
  const sb = await makeSandbox('[[section]]\nname = "s"\n', {
    env: { BOOM_OS: "linux", NO_COLOR: undefined },
  });
  expect(sb.env.BOOM_OS).toBe("linux");
  expect(sb.env.NO_COLOR).toBeUndefined();
  // Overriding one key must not drop the rest of the isolation.
  expect(sb.env.GIT_CONFIG_NOSYSTEM).toBe("1");
  expect(sb.env.HOME).toBe(sb.home);
});

test("two sandboxes never share a directory", async () => {
  const a = await makeSandbox('[[section]]\nname = "s"\n');
  const b = await makeSandbox('[[section]]\nname = "s"\n');
  expect(a.base).not.toBe(b.base);
});
