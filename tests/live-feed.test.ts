import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LiveFeedDebate,
  type DebateAgent,
  type TextDeltaHandler,
} from "../src/live-feed";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

class Gate {
  readonly promise: Promise<void>;
  private resolvePromise: (() => void) | undefined;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  open(): void {
    this.resolvePromise?.();
  }
}

class FakeAgent implements DebateAgent {
  readonly prompts: string[] = [];
  abortCalls = 0;
  disposeCalls = 0;

  constructor(
    private readonly behavior: (
      prompt: string,
      onText: TextDeltaHandler,
      call: number,
    ) => Promise<void>,
    private readonly onAbort?: () => void,
  ) {}

  prompt(prompt: string, onText: TextDeltaHandler): Promise<void> {
    this.prompts.push(prompt);
    return this.behavior(prompt, onText, this.prompts.length);
  }

  abort(): Promise<void> {
    this.abortCalls += 1;
    this.onAbort?.();
    return Promise.resolve();
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

async function temporaryRunDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "heated-debate-v3-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await Bun.sleep(2);
  }
}

describe("LiveFeedDebate", () => {
  test("wakes the verifier from a partial proposer stream", async () => {
    const runDirectory = await temporaryRunDirectory();
    const proposerGate = new Gate();
    const verifierGate = new Gate();
    const proposer = new FakeAgent(async (_prompt, onText) => {
      onText("A proposal is arriving");
      await proposerGate.promise;
      onText(".\n\nV3_STATUS: CONTINUE");
    }, () => {
      proposerGate.open();
    });
    const verifier = new FakeAgent(async (_prompt, onText) => {
      onText("I can already inspect the partial proposal.\n\nV3_STATUS: CONTINUE");
      await verifierGate.promise;
    }, () => {
      verifierGate.open();
    });
    const debate = new LiveFeedDebate({
      runDirectory,
      topic: "Design a cache.",
      proposer,
      verifier,
      pollIntervalMs: 2,
      maxDurationMs: 2_000,
    });

    const resultPromise = debate.run();
    await waitUntil(() => verifier.prompts.length === 1);

    expect(proposer.prompts).toHaveLength(1);
    expect(await readFile(join(runDirectory, "proposer.md"), "utf8"))
      .toContain("A proposal is arriving");

    await debate.stop();
    const result = await resultPromise;
    expect(result.reason).toBe("host_shutdown");
  });

  test("stops when both latest completed messages declare done", async () => {
    const runDirectory = await temporaryRunDirectory();
    const proposer = new FakeAgent((_prompt, onText) => {
      onText("The proposal is complete.\n\nV3_STATUS: DONE");
      return Promise.resolve();
    });
    const verifier = new FakeAgent((_prompt, onText) => {
      onText("I accept the proposal.\n\nV3_STATUS: DONE");
      return Promise.resolve();
    });

    const result = await new LiveFeedDebate({
      runDirectory,
      topic: "Choose an approach.",
      proposer,
      verifier,
      pollIntervalMs: 2,
      maxDurationMs: 500,
    }).run();

    expect(result.reason).toBe("consensus");
    expect(proposer.prompts).toHaveLength(1);
    expect(verifier.prompts).toHaveLength(1);
    expect(proposer.disposeCalls).toBe(1);
    expect(verifier.disposeCalls).toBe(1);
  });

  test("records streaming timing in the feeds", async () => {
    const runDirectory = await temporaryRunDirectory();
    const proposer = new FakeAgent((_prompt, onText) => {
      onText("First");
      onText(" message.\n\nV3_STATUS: DONE");
      return Promise.resolve();
    });
    const verifier = new FakeAgent((_prompt, onText) => {
      onText("Verified.\n\nV3_STATUS: DONE");
      return Promise.resolve();
    });

    await new LiveFeedDebate({
      runDirectory,
      topic: "Time this.",
      proposer,
      verifier,
      pollIntervalMs: 2,
      maxDurationMs: 500,
    }).run();

    const feed = await readFile(join(runDirectory, "proposer.md"), "utf8");
    expect(feed).toMatch(/^## proposer \| \d{4}-\d{2}-\d{2}T/m);
    expect(feed).toMatch(/prompted_at: .*; first_text_ms: \d+/);
    expect(feed).toContain("First message.");
    expect(feed).toMatch(/completed_at: .*; elapsed_ms: \d+/);
  });

  test("reports lightweight participant progress", async () => {
    const runDirectory = await temporaryRunDirectory();
    const progress: string[] = [];
    const proposer = new FakeAgent((_prompt, onText) => {
      onText("Proposed.\n\nV3_STATUS: DONE");
      return Promise.resolve();
    });
    const verifier = new FakeAgent((_prompt, onText) => {
      onText("Verified.\n\nV3_STATUS: DONE");
      return Promise.resolve();
    });

    await new LiveFeedDebate({
      runDirectory,
      topic: "Show progress.",
      proposer,
      verifier,
      pollIntervalMs: 2,
      maxDurationMs: 500,
      onProgress(event) {
        progress.push([
          event.type,
          event.participant,
          "trigger" in event ? event.trigger : event.status,
        ].join(":"));
      },
    }).run();

    expect(progress).toEqual([
      "participant_started:proposer:initial",
      "participant_completed:proposer:DONE",
      "participant_started:verifier:peer_growth",
      "participant_completed:verifier:DONE",
    ]);
  });

  test("aborts an active participant at the wall-clock limit", async () => {
    const runDirectory = await temporaryRunDirectory();
    const gate = new Gate();
    const proposer = new FakeAgent(async (_prompt, onText) => {
      onText("Still working");
      await gate.promise;
    }, () => {
      gate.open();
    });
    const verifier = new FakeAgent(() => Promise.resolve());

    const result = await new LiveFeedDebate({
      runDirectory,
      topic: "Run until capped.",
      proposer,
      verifier,
      pollIntervalMs: 2,
      maxDurationMs: 20,
    }).run();

    expect(result.reason).toBe("max_duration");
    expect(proposer.abortCalls).toBe(1);
    expect(proposer.disposeCalls).toBe(1);
    expect(await readFile(join(runDirectory, "proposer.md"), "utf8"))
      .toContain("termination: max_duration");
  });

  test("stops both sessions when one participant fails", async () => {
    const runDirectory = await temporaryRunDirectory();
    const proposer = new FakeAgent(() => Promise.reject(new Error("provider unavailable")));
    const verifier = new FakeAgent(() => Promise.resolve());

    const result = await new LiveFeedDebate({
      runDirectory,
      topic: "Handle failure.",
      proposer,
      verifier,
      pollIntervalMs: 2,
      maxDurationMs: 500,
    }).run();

    expect(result.reason).toBe("participant_failure");
    expect(result.failure).toContain("proposer: provider unavailable");
    expect(proposer.disposeCalls).toBe(1);
    expect(verifier.disposeCalls).toBe(1);
    expect(await readFile(join(runDirectory, "proposer.md"), "utf8"))
      .toContain("failed: provider unavailable");
  });
});
