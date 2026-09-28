import {
  type CreateAgentSessionOptions,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { resolveContextPaths } from "./context";
import {
  type DebateProgressEvent,
  type DebateRunResult,
  LiveFeedDebate,
  type ParticipantName,
} from "./live-feed";
import { createPiDebateAgents } from "./pi-agent";
import {
  TelegramProgressReporter,
  telegramConfigFromEnv,
} from "./telegram";
import {
  createTavilyWebSearchTool,
  tavilyConfigFromEnv,
} from "./web-search";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export interface ModelChoice {
  providerId: string;
  modelId: string;
}

export interface CliArguments {
  topic: string;
  maxDurationMs: number;
  models: Record<ParticipantName, ModelChoice>;
  thinkingLevel: ThinkingLevel;
  contextPaths: string[];
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
  let sharedModel: ModelChoice = {
    providerId: DEFAULT_PROVIDER_ID,
    modelId: DEFAULT_MODEL_ID,
  };
  const roleModels: Partial<Record<ParticipantName, ModelChoice>> = {};
  let thinkingLevel = DEFAULT_THINKING_LEVEL;
  const contextPaths: string[] = [];
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
      sharedModel = parseModelChoice(requiredOptionValue(args, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--proposer-model" || argument === "--verifier-model") {
      const participant = argument === "--proposer-model" ? "proposer" : "verifier";
      roleModels[participant] = parseModelChoice(
        requiredOptionValue(args, index, argument),
      );
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
    if (argument === "--context") {
      contextPaths.push(requiredOptionValue(args, index, argument));
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
    models: {
      proposer: roleModels.proposer ?? sharedModel,
      verifier: roleModels.verifier ?? sharedModel,
    },
    thinkingLevel,
    contextPaths,
  };
}

function parseModelChoice(model: string): ModelChoice {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error("model must use provider/model");
  }
  return {
    providerId: model.slice(0, separator),
    modelId: model.slice(separator + 1),
  };
}

export function modelLabel(models: Record<ParticipantName, ModelChoice>): string {
  const proposer = `${models.proposer.providerId}/${models.proposer.modelId}`;
  const verifier = `${models.verifier.providerId}/${models.verifier.modelId}`;
  return proposer === verifier
    ? proposer
    : `proposer ${proposer} vs verifier ${verifier}`;
}

export function progressLine(
  event: DebateProgressEvent,
  now = new Date(),
): string | undefined {
  if (event.type === "participant_text") return undefined;
  const prefix = `[${now.toISOString()}] ${event.participant}`;
  if (event.type === "participant_started") {
    const cause = event.trigger === "initial" ? "initial" : "peer update";
    return `${prefix} started (${cause})`;
  }
  if (event.aborted) return `${prefix} finished in ${formatSeconds(event.elapsedMs)} (aborted)`;
  const status = event.status?.toLowerCase() ?? "no status";
  return `${prefix} finished in ${formatSeconds(event.elapsedMs)} (${status})`;
}

export async function runCli(
  args: readonly string[],
  cwd = process.cwd(),
): Promise<DebateRunResult> {
  const options = parseCliArguments(args);
  const contextPaths = await resolveContextPaths(options.contextPaths, cwd);
  const telegramConfig = telegramConfigFromEnv(process.env);
  const tavilyConfig = tavilyConfigFromEnv(process.env);
  const webSearchTool = tavilyConfig === undefined
    ? undefined
    : createTavilyWebSearchTool(tavilyConfig);
  const telegram = telegramConfig === undefined
    ? undefined
    : new TelegramProgressReporter({
        ...telegramConfig,
        onWarning(message) {
          console.error(message);
        },
      });
  const modelRuntime = await ModelRuntime.create();
  const resolveModel = (choice: ModelChoice) => {
    const model = modelRuntime.getModel(choice.providerId, choice.modelId);
    if (model === undefined) {
      throw new Error(`unknown model: ${choice.providerId}/${choice.modelId}`);
    }
    return model;
  };
  const models = {
    proposer: resolveModel(options.models.proposer),
    verifier: resolveModel(options.models.verifier),
  };
  const label = modelLabel(options.models);

  const runsDirectory = join(cwd, "runs");
  await mkdir(runsDirectory, { recursive: true });
  const runDirectory = await mkdtemp(join(runsDirectory, "run-"));
  const agents = await createPiDebateAgents({
    cwd,
    runDirectory,
    models,
    thinkingLevel: options.thinkingLevel,
    contextPaths,
    modelRuntime,
    ...(webSearchTool === undefined
      ? {}
      : {
          customTools: [webSearchTool],
          webSearchAvailable: true,
        }),
  });
  const debate = new LiveFeedDebate({
    runDirectory,
    topic: options.topic,
    contextPaths,
    proposer: agents.proposer,
    verifier: agents.verifier,
    maxDurationMs: options.maxDurationMs,
    onProgress(event) {
      const line = progressLine(event);
      if (line !== undefined) console.log(line);
      telegram?.handle(event);
    },
  });
  const interrupt = (): void => {
    console.log(`[${new Date().toISOString()}] stopping after interrupt`);
    void debate.stop();
  };

  console.log([
    `[${new Date().toISOString()}] debate started`,
    label,
    options.thinkingLevel,
    `${String(contextPaths.length)} context sources`,
    `web search ${webSearchTool === undefined ? "disabled" : "enabled"}`,
    runDirectory,
  ].join(" | "));
  telegram?.startRun({
    topic: options.topic,
    model: label,
    maxDurationMs: options.maxDurationMs,
  });
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
    await telegram?.close();
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
      "Usage: bun run debate [--max-minutes N] [--model provider/model] [--proposer-model provider/model] [--verifier-model provider/model] [--thinking LEVEL] [--context PATH]... <topic>",
    );
    process.exitCode = 1;
  }
}
