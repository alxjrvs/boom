// Drift notifications: the platform notifier boom shells out to after a verify finds drift.
import { expect, test } from "bun:test";
import { notifyArgv } from "../src/lib/notify.ts";

test("notifyArgv: platform-correct commands, undefined where boom has no notifier", () => {
  expect(notifyArgv("darwin", "boom", "drift")?.[0]).toBe("osascript");
  expect(notifyArgv("linux", "boom", "drift")).toEqual(["notify-send", "boom", "drift"]);
  expect(notifyArgv("unknown", "boom", "drift")).toBeUndefined();
});
