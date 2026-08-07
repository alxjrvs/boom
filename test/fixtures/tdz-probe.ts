// Not a test — the entry point test/layering.test.ts spawns to prove the engine→commands
// require cycle is safe to enter FROM THE ENGINE. `engine/settings.ts` must be the very first
// import: with the old `settings.ts` → `commands/skill.ts` edge that is exactly the condition
// under which `cli.ts`'s route map read `skillCommand` in its temporal dead zone, which is why
// `settings.ts` primed the cycle with `await import("../cli.ts")` instead of importing
// statically. Rendering the doc forces `commandList()` all the way through the cycle, so this
// fails on a load error *and* on a doc that came back without its command list.
//
// It has to be a separate process: `bun test` shares one ES module registry across test files,
// and several alphabetically-earlier suites statically import `src/cli.ts`, so an in-process
// version of this check would pass whether or not the hazard exists.
import "../../src/engine/settings.ts";
import { skillDoc } from "../../src/engine/skill.ts";

console.log(skillDoc("9.9.9"));
