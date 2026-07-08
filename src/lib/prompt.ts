// Interactive y/n confirmation for conflicting link targets. Mirrors the legacy bash
// `[[ -t 0 ]] && read -rp ... || choice="s"`: only prompts on a real terminal, and
// defaults to "no" for anything else (pipe, redirect, CI) so scripted runs never hang.
import { createInterface } from "node:readline/promises";

export async function confirmOverwrite(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(message);
    return answer.trim().toLowerCase().startsWith("o");
  } finally {
    rl.close();
  }
}
