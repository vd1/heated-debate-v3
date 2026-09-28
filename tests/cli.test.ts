import { describe, expect, test } from "bun:test";

import { modelLabel, parseCliArguments, progressLine } from "../src/cli";

describe("parseCliArguments", () => {
  test("uses the standalone defaults", () => {
    expect(parseCliArguments(["Compare", "live", "feeds"])).toEqual({
      topic: "Compare live feeds",
      maxDurationMs: 300_000,
      models: {
        proposer: { providerId: "openai-codex", modelId: "gpt-5.6-sol" },
        verifier: { providerId: "openai-codex", modelId: "gpt-5.6-sol" },
      },
      thinkingLevel: "high",
      contextPaths: [],
    });
  });

  test("accepts model, thinking, duration, and context overrides", () => {
    expect(parseCliArguments([
      "--model", "anthropic/claude-sonnet-4-5",
      "--thinking", "medium",
      "--max-minutes", "1.5",
      "--context", "notes/constraints.md",
      "--context", "papers/result.pdf",
      "Compare A and B",
    ])).toEqual({
      topic: "Compare A and B",
      maxDurationMs: 90_000,
      models: {
        proposer: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
        verifier: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      },
      thinkingLevel: "medium",
      contextPaths: [
        "notes/constraints.md",
        "papers/result.pdf",
      ],
    });
  });

  test("lets each participant use its own model", () => {
    const parsed = parseCliArguments([
      "--verifier-model", "anthropic/claude-opus-5",
      "--model", "openai-codex/gpt-6-astra",
      "Topic",
    ]);
    expect(parsed.models).toEqual({
      proposer: { providerId: "openai-codex", modelId: "gpt-6-astra" },
      verifier: { providerId: "anthropic", modelId: "claude-opus-5" },
    });
    expect(modelLabel(parsed.models)).toBe(
      "proposer openai-codex/gpt-6-astra vs verifier anthropic/claude-opus-5",
    );
    expect(modelLabel(parseCliArguments(["Topic"]).models))
      .toBe("openai-codex/gpt-5.6-sol");
  });

  test("rejects missing topics and malformed options", () => {
    expect(() => parseCliArguments([])).toThrow("topic is required");
    expect(() => parseCliArguments(["--model", "missing-slash", "Topic"]))
      .toThrow("model must use provider/model");
    expect(() => parseCliArguments(["--proposer-model", "anthropic/", "Topic"]))
      .toThrow("model must use provider/model");
    expect(() => parseCliArguments(["--thinking", "extreme", "Topic"]))
      .toThrow("unsupported thinking level");
    expect(() => parseCliArguments(["--context", "--thinking", "Topic"]))
      .toThrow("--context requires a value");
    expect(() => parseCliArguments(["--wat", "Topic"]))
      .toThrow("unknown option: --wat");
  });
});

describe("progressLine", () => {
  const timestamp = new Date("2026-07-23T10:30:00.000Z");

  test("formats participant start and completion events", () => {
    expect(progressLine({
      type: "participant_started",
      participant: "verifier",
      trigger: "peer_growth",
    }, timestamp)).toBe(
      "[2026-07-23T10:30:00.000Z] verifier started (peer update)",
    );
    expect(progressLine({
      type: "participant_completed",
      participant: "verifier",
      status: "CONTINUE",
      elapsedMs: 12_345,
      aborted: false,
    }, timestamp)).toBe(
      "[2026-07-23T10:30:00.000Z] verifier finished in 12.3s (continue)",
    );
    expect(progressLine({
      type: "participant_completed",
      participant: "proposer",
      status: undefined,
      elapsedMs: 9_000,
      aborted: true,
    }, timestamp)).toBe(
      "[2026-07-23T10:30:00.000Z] proposer finished in 9.0s (aborted)",
    );
    expect(progressLine({
      type: "participant_text",
      participant: "proposer",
      delta: "partial text",
    }, timestamp)).toBeUndefined();
  });
});
