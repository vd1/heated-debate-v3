import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { contextManifest } from "./context";

export type ParticipantName = "proposer" | "verifier";
export type DebateStatus = "CONTINUE" | "DONE";
export type DebateTerminationReason =
  | "consensus"
  | "max_duration"
  | "participant_failure"
  | "host_shutdown";

export type TextDeltaHandler = (delta: string) => void;

export interface DebateAgent {
  prompt(prompt: string, onText: TextDeltaHandler): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export interface LiveFeedDebateInput {
  runDirectory: string;
  topic: string;
  contextPaths?: readonly string[];
  proposer: DebateAgent;
  verifier: DebateAgent;
  pollIntervalMs?: number;
  maxDurationMs?: number;
  onProgress?: (event: DebateProgressEvent) => void;
}

export type DebateProgressEvent =
  | {
      type: "participant_started";
      participant: ParticipantName;
      trigger: "initial" | "peer_growth";
    }
  | {
      type: "participant_text";
      participant: ParticipantName;
      delta: string;
    }
  | {
      type: "participant_completed";
      participant: ParticipantName;
      status: DebateStatus | undefined;
      elapsedMs: number;
      aborted: boolean;
    };

export interface DebateRunResult {
  runDirectory: string;
  reason: DebateTerminationReason;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  failure?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1_000;

interface ParticipantState {
  readonly name: ParticipantName;
  readonly agent: DebateAgent;
  readonly feedPath: string;
  readonly peerFeedPath: string;
  busy: boolean;
  peerBytesAtLastPrompt: number;
  latestStatus: DebateStatus | undefined;
  active: Promise<void> | undefined;
}

export class LiveFeedDebate {
  private readonly runDirectory: string;
  private readonly topic: string;
  private readonly contextPaths: readonly string[];
  private readonly pollIntervalMs: number;
  private readonly maxDurationMs: number;
  private readonly onProgress: ((event: DebateProgressEvent) => void) | undefined;
  private readonly proposer: ParticipantState;
  private readonly verifier: ParticipantState;
  private hasRun = false;
  private terminationReason: DebateTerminationReason | undefined;
  private failure: string | undefined;
  private abortPromise: Promise<void> | undefined;
  private deadlineAtMs: number | undefined;

  constructor(input: LiveFeedDebateInput) {
    if (input.topic.trim().length === 0) throw new Error("topic is required");
    this.pollIntervalMs = positiveNumber(
      input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "poll interval",
    );
    this.maxDurationMs = positiveNumber(
      input.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      "max duration",
    );
    this.runDirectory = input.runDirectory;
    this.topic = input.topic.trim();
    this.contextPaths = input.contextPaths ?? [];
    this.onProgress = input.onProgress;
    this.proposer = {
      name: "proposer",
      agent: input.proposer,
      feedPath: join(input.runDirectory, "proposer.md"),
      peerFeedPath: join(input.runDirectory, "verifier.md"),
      busy: false,
      peerBytesAtLastPrompt: 0,
      latestStatus: undefined,
      active: undefined,
    };
    this.verifier = {
      name: "verifier",
      agent: input.verifier,
      feedPath: join(input.runDirectory, "verifier.md"),
      peerFeedPath: join(input.runDirectory, "proposer.md"),
      busy: false,
      peerBytesAtLastPrompt: 0,
      latestStatus: undefined,
      active: undefined,
    };
  }

  async run(): Promise<DebateRunResult> {
    if (this.hasRun) throw new Error("a live-feed debate can only run once");
    this.hasRun = true;
    const startedAtMs = Date.now();
    this.deadlineAtMs = startedAtMs + this.maxDurationMs;

    try {
      await this.prepareFiles();
      await this.launch(
        this.proposer,
        [
          approximateTimeRemaining(this.remainingMs()),
          `Read ${join(this.runDirectory, "topic.md")} and begin the debate with a concrete proposal.`,
          "Your response is streamed automatically to your feed. Converge as the deadline approaches.",
        ].join(" "),
        "initial",
      );

      while (this.terminationReason === undefined) {
        await sleep(this.pollIntervalMs);

        if (this.remainingMs() <= 0) {
          this.terminationReason = "max_duration";
          break;
        }
        if (this.hasConsensus()) {
          this.terminationReason = "consensus";
          break;
        }

        await this.wakeForPeerGrowth(this.proposer);
        await this.wakeForPeerGrowth(this.verifier);
      }

      if (this.terminationReason !== "consensus") await this.abortActiveAgents();
      await this.waitForActiveAgents();

      const reason = this.terminationReason;
      const completedAtMs = Date.now();
      await this.appendTermination(reason, completedAtMs);
      return {
        runDirectory: this.runDirectory,
        reason,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        elapsedMs: Math.max(0, completedAtMs - startedAtMs),
        ...(this.failure === undefined ? {} : { failure: this.failure }),
      };
    } finally {
      this.proposer.agent.dispose();
      this.verifier.agent.dispose();
    }
  }

  async stop(): Promise<void> {
    if (this.terminationReason === undefined) this.terminationReason = "host_shutdown";
    await this.abortActiveAgents();
  }

  private async prepareFiles(): Promise<void> {
    await mkdir(this.runDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(this.runDirectory, "topic.md"), `${this.topic}\n`, "utf8"),
      writeFile(
        join(this.runDirectory, "context.md"),
        contextManifest(this.contextPaths),
        "utf8",
      ),
      writeFile(this.proposer.feedPath, "", "utf8"),
      writeFile(this.verifier.feedPath, "", "utf8"),
    ]);
  }

  private async launch(
    state: ParticipantState,
    prompt: string,
    trigger: "initial" | "peer_growth",
  ): Promise<void> {
    if (state.busy || this.terminationReason !== undefined) return;
    state.peerBytesAtLastPrompt = await fileSize(state.peerFeedPath);
    state.busy = true;
    const startedAtMs = Date.now();
    this.emitProgress({
      type: "participant_started",
      participant: state.name,
      trigger,
    });
    const activation = new FeedActivation(state.name, state.feedPath);

    const active = state.agent.prompt(prompt, (delta) => {
      activation.appendText(delta);
      if (delta.length > 0) {
        this.emitProgress({
          type: "participant_text",
          participant: state.name,
          delta,
        });
      }
    }).then(async () => {
      const aborted = this.terminationReason !== undefined
        && this.terminationReason !== "consensus";
      state.latestStatus = await activation.complete(aborted);
      this.emitProgress({
        type: "participant_completed",
        participant: state.name,
        status: state.latestStatus,
        elapsedMs: Math.max(0, Date.now() - startedAtMs),
        aborted,
      });
    }).catch(async (error: unknown) => {
      const message = errorMessage(error);
      await activation.fail(message);
      if (this.terminationReason === undefined) {
        this.failure = `${state.name}: ${message}`;
        this.terminationReason = "participant_failure";
      }
    }).finally(() => {
      state.busy = false;
      if (state.active === active) state.active = undefined;
    });
    state.active = active;
  }

  private async wakeForPeerGrowth(state: ParticipantState): Promise<void> {
    if (state.busy || this.terminationReason !== undefined) return;
    const currentBytes = await fileSize(state.peerFeedPath);
    if (currentBytes <= state.peerBytesAtLastPrompt) return;
    await this.launch(state, [
      "The peer feed has grown.",
      approximateTimeRemaining(this.remainingMs()),
      "Pull it now and respond to the newest useful content.",
      "If no material issue remains, finish with V3_STATUS: DONE.",
    ].join(" "), "peer_growth");
  }

  private hasConsensus(): boolean {
    return !this.proposer.busy
      && !this.verifier.busy
      && this.proposer.latestStatus === "DONE"
      && this.verifier.latestStatus === "DONE";
  }

  private abortActiveAgents(): Promise<void> {
    this.abortPromise ??= Promise.all(
      [this.proposer, this.verifier]
        .filter((state) => state.busy)
        .map(async (state) => {
          try {
            await state.agent.abort();
          } catch {
            // Cleanup continues so both sessions can be disposed.
          }
        }),
    ).then(() => undefined);
    return this.abortPromise;
  }

  private async waitForActiveAgents(): Promise<void> {
    const active = [this.proposer.active, this.verifier.active].filter(
      (operation): operation is Promise<void> => operation !== undefined,
    );
    await Promise.all(active);
  }

  private async appendTermination(
    reason: DebateTerminationReason,
    completedAtMs: number,
  ): Promise<void> {
    const marker = [
      "",
      `<!-- debate termination: ${reason}; completed_at: ${new Date(completedAtMs).toISOString()}`,
      ...(this.failure === undefined ? [] : [`; failure: ${commentText(this.failure)}`]),
      " -->",
      "",
    ].join("");
    await Promise.all([
      appendFile(this.proposer.feedPath, marker, "utf8"),
      appendFile(this.verifier.feedPath, marker, "utf8"),
    ]);
  }

  private emitProgress(event: DebateProgressEvent): void {
    try {
      this.onProgress?.(event);
    } catch {
      // Display callbacks must not affect the debate.
    }
  }

  private remainingMs(): number {
    return Math.max(0, (this.deadlineAtMs ?? Date.now()) - Date.now());
  }
}

class FeedActivation {
  private readonly promptedAtMs = Date.now();
  private firstTextAtMs: number | undefined;
  private fullText = "";
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly participant: ParticipantName,
    private readonly feedPath: string,
  ) {}

  appendText(delta: string): void {
    if (delta.length === 0) return;
    const first = this.firstTextAtMs === undefined;
    if (first) this.firstTextAtMs = Date.now();
    this.fullText += delta;
    const chunk = first ? `${this.header(this.firstTextAtMs ?? Date.now())}${delta}` : delta;
    this.enqueue(chunk);
  }

  async complete(aborted: boolean): Promise<DebateStatus | undefined> {
    const completedAtMs = Date.now();
    if (this.firstTextAtMs === undefined) {
      this.firstTextAtMs = completedAtMs;
      const message = aborted
        ? "[Aborted before visible assistant text.]"
        : "[No visible assistant text.]";
      this.enqueue(`${this.header(completedAtMs)}${message}`);
    }
    this.enqueue(aborted
      ? this.abortedFooter(completedAtMs)
      : this.completionFooter(completedAtMs));
    await this.writes;
    return finalStatus(this.fullText);
  }

  async fail(message: string): Promise<void> {
    const failedAtMs = Date.now();
    if (this.firstTextAtMs === undefined) {
      this.firstTextAtMs = failedAtMs;
      this.enqueue(this.header(failedAtMs));
    }
    this.enqueue([
      "",
      `<!-- failed: ${commentText(message)}; failed_at: ${new Date(failedAtMs).toISOString()}`,
      `; elapsed_ms: ${String(Math.max(0, failedAtMs - this.promptedAtMs))} -->`,
      "",
    ].join(""));
    await this.writes;
  }

  private header(firstTextAtMs: number): string {
    return [
      `## ${this.participant} | ${new Date(firstTextAtMs).toISOString()}`,
      `<!-- prompted_at: ${new Date(this.promptedAtMs).toISOString()}; first_text_ms: ${String(Math.max(0, firstTextAtMs - this.promptedAtMs))} -->`,
      "",
      "",
    ].join("\n");
  }

  private completionFooter(completedAtMs: number): string {
    return [
      "",
      `<!-- completed_at: ${new Date(completedAtMs).toISOString()}; elapsed_ms: ${String(Math.max(0, completedAtMs - this.promptedAtMs))} -->`,
      "",
      "",
    ].join("\n");
  }

  private abortedFooter(abortedAtMs: number): string {
    return [
      "",
      `<!-- aborted_at: ${new Date(abortedAtMs).toISOString()}; elapsed_ms: ${String(Math.max(0, abortedAtMs - this.promptedAtMs))} -->`,
      "",
      "",
    ].join("\n");
  }

  private enqueue(text: string): void {
    this.writes = this.writes.then(() => appendFile(this.feedPath, text, "utf8"));
  }
}

function finalStatus(text: string): DebateStatus | undefined {
  const lastLine = text.trim().split(/\r?\n/u).at(-1);
  if (lastLine === "V3_STATUS: CONTINUE") return "CONTINUE";
  if (lastLine === "V3_STATUS: DONE") return "DONE";
  return undefined;
}

function approximateTimeRemaining(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1_000));
  return `Approximately ${String(seconds)} ${seconds === 1 ? "second" : "seconds"} remain.`;
}

async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commentText(value: string): string {
  return value.replaceAll("--", "- -").replaceAll(/\s+/gu, " ").trim();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
