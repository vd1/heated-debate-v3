import {
  type CreateAgentSessionOptions,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import {
  type DebateProgressEvent,
  type DebateRunResult,
  LiveFeedDebate,
} from "./live-feed";
import { createPiDebateAgents } from "./pi-agent";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export interface CliArguments {
  topic: string;
  maxDurationMs: number;
  providerId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1_000;
const DEFAULT_PROVIDER_ID = "openai-codex";
const DEFAULT_MODEL_ID = "gpt-5.6-sol";
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function parseCliArguments(args: readonly string[]): CliArguments {
  let maxDurationMs = DEFAULT_MAX_DURATION_MS;
  let providerId = DEFAULT_PROVIDER_ID;
  let modelId = DEFAULT_MODEL_ID;
  let thinkingLevel = DEFAULT_THINKING_LEVEL;
  const topicParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      topicParts.push(...args.slice(index + 1));
      break;
    }
    if (argument === "--max-minutes") {
      const minutes = Number(requiredOptionValue(args, index, argument));
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error("max minutes must be a positive number");
      }
      maxDurationMs = minutes * 60 * 1_000;
      index += 1;
      continue;
    }
    if (argument === "--model") {
      const model = requiredOptionValue(args, index, argument);
      const separator = model.indexOf("/");
      if (separator <= 0 || separator === model.length - 1) {
        throw new Error("model must use provider/model");
      }
      providerId = model.slice(0, separator);
      modelId = model.slice(separator + 1);
      index += 1;
      continue;
    }
    if (argument === "--thinking") {
      const value = requiredOptionValue(args, index, argument);
      if (!THINKING_LEVELS.has(value as ThinkingLevel)) {
        throw new Error(`unsupported thinking level: ${value}`);
      }
      thinkingLevel = value as ThinkingLevel;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--") === true) {
      throw new Error(`unknown option: ${argument}`);
    }
    if (argument !== undefined) topicParts.push(argument);
  }

  const topic = topicParts.join(" ").trim();
  if (topic.length === 0) throw new Error("topic is required");
  return {
    topic,
    maxDurationMs,
    providerId,
    modelId,
    thinkingLevel,
  };
}

export function progressLine(
  event: DebateProgressEvent,
  now = new Date(),
): string {
  const prefix = `[${now.toISOString()}] ${event.participant}`;
  if (event.type === "participant_started") {
    const cause = event.trigger === "initial" ? "initial" : "peer update";
    return `${prefix} started (${cause})`;
  }
  const status = event.status?.toLowerCase() ?? "no status";
  return `${prefix} finished in ${formatSeconds(event.elapsedMs)} (${status})`;
}

export async function runCli(
  args: readonly string[],
  cwd = process.cwd(),
): Promise<DebateRunResult> {
  const options = parseCliArguments(args);
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(options.providerId, options.modelId);
  if (model === undefined) {
    throw new Error(`unknown model: ${options.providerId}/${options.modelId}`);
  }

  const runsDirectory = join(cwd, "runs");
  await mkdir(runsDirectory, { recursive: true });
  const runDirectory = await mkdtemp(join(runsDirectory, "run-"));
  const agents = await createPiDebateAgents({
    cwd,
    runDirectory,
    model,
    thinkingLevel: options.thinkingLevel,
    modelRuntime,
  });
  const debate = new LiveFeedDebate({
    runDirectory,
    topic: options.topic,
    proposer: agents.proposer,
    verifier: agents.verifier,
    maxDurationMs: options.maxDurationMs,
    onProgress(event) {
      console.log(progressLine(event));
    },
  });
  const interrupt = (): void => {
    console.log(`[${new Date().toISOString()}] stopping after interrupt`);
    void debate.stop();
  };

  console.log([
    `[${new Date().toISOString()}] debate started`,
    `${options.providerId}/${options.modelId}`,
    options.thinkingLevel,
    runDirectory,
  ].join(" | "));
  process.once("SIGINT", interrupt);
  try {
    const result = await debate.run();
    console.log([
      `[${new Date().toISOString()}] debate stopped`,
      result.reason,
      formatSeconds(result.elapsedMs),
      result.runDirectory,
    ].join(" | "));
    return result;
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

function requiredOptionValue(
  args: readonly string[],
  index: number,
  option: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  try {
    const result = await runCli(Bun.argv.slice(2));
    if (result.reason === "participant_failure") process.exitCode = 1;
  } catch (error) {
    console.error(`debate3 failed: ${errorMessage(error)}`);
    console.error(
      "Usage: bun run debate [--max-minutes N] [--model provider/model] [--thinking LEVEL] <topic>",
    );
    process.exitCode = 1;
  }
}
