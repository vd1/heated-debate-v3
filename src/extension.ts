import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { LiveFeedDebate, parseDebateCommand } from "./live-feed";
import { createPiDebateAgents } from "./pi-agent";

export default function debate3Extension(pi: ExtensionAPI): void {
  let activeDebate: LiveFeedDebate | undefined;

  pi.registerCommand("debate3", {
    description: "Run a continuous proposer and verifier debate over live Markdown feeds",
    handler: async (args, ctx) => {
      if (activeDebate !== undefined) {
        ctx.ui.notify("A debate3 run is already active", "warning");
        return;
      }
      if (ctx.model === undefined) {
        ctx.ui.notify("Select a model before starting debate3", "error");
        return;
      }

      let command;
      try {
        command = parseDebateCommand(args);
      } catch (error) {
        ctx.ui.notify(
          `${errorMessage(error)}. Usage: /debate3 [--max-minutes N] <topic>`,
          "error",
        );
        return;
      }

      const runsDirectory = join(ctx.cwd, "runs");
      await mkdir(runsDirectory, { recursive: true });
      const runDirectory = await mkdtemp(join(runsDirectory, "run-"));
      ctx.ui.setStatus("debate3", "debate3: starting");

      try {
        const agents = await createPiDebateAgents({
          cwd: ctx.cwd,
          runDirectory,
          model: ctx.model,
          thinkingLevel: pi.getThinkingLevel(),
        });
        const debate = new LiveFeedDebate({
          runDirectory,
          topic: command.topic,
          proposer: agents.proposer,
          verifier: agents.verifier,
          maxDurationMs: command.maxDurationMs,
        });
        activeDebate = debate;
        ctx.ui.setStatus("debate3", "debate3: running");

        const result = await debate.run();
        const message = [
          `debate3 stopped: ${result.reason}`,
          `elapsed ${formatSeconds(result.elapsedMs)}`,
          result.runDirectory,
        ].join(" | ");
        ctx.ui.notify(
          message,
          result.reason === "consensus" ? "info" : "warning",
        );
      } catch (error) {
        ctx.ui.notify(`debate3 failed: ${errorMessage(error)}`, "error");
      } finally {
        activeDebate = undefined;
        ctx.ui.setStatus("debate3", undefined);
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await activeDebate?.stop();
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}
