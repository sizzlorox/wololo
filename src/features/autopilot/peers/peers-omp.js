// omp hook for parallel autopilot workers, loaded per run with `omp --hook=<this file>`.
// Plain JS (valid TS) so omp needs no types. The logic lives in peers.cjs, shared with Claude Code.
import { createRequire } from "node:module";

const peers = createRequire(import.meta.url)("./peers.cjs");

/** @param {{ on: (event: string, handler: (event: any, ctx?: any) => Promise<any>) => void }} pi */
export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    const reason = peers.pre(event.toolName ?? event.name, event.input ?? event.arguments, ctx?.cwd ?? process.cwd());
    return reason ? { block: true, reason } : undefined;
  });

  pi.on("tool_result", async () => {
    const context = peers.post();
    return context ? { additionalContext: context } : undefined;
  });
}
