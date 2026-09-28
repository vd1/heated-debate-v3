import { describe, expect, test } from "bun:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { PiDebateAgent, participantProtocolPrompt } from "../src/pi-agent";

function sessionEndingWith(message: Record<string, unknown>): AgentSession {
  return {
    messages: [message],
    subscribe: () => () => undefined,
    prompt: () => Promise.resolve(),
  } as unknown as AgentSession;
}

describe("PiDebateAgent", () => {
  test("rejects when the provider call ends in an error", async () => {
    const agent = new PiDebateAgent(sessionEndingWith({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "OAuth refresh failed for anthropic",
    }));

    const error = await agent.prompt("Respond.", () => undefined)
      .then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("OAuth refresh failed for anthropic");
  });

  test("resolves for completed and aborted responses", async () => {
    for (const stopReason of ["stop", "aborted"]) {
      const agent = new PiDebateAgent(sessionEndingWith({
        role: "assistant",
        content: [],
        stopReason,
      }));
      await agent.prompt("Respond.", () => undefined);
    }
  });
});

describe("participantProtocolPrompt", () => {
  test("gives each participant its role, peer feed, and completion markers", () => {
    const prompt = participantProtocolPrompt({
      participant: "verifier",
      peerFeedPath: "/tmp/run/proposer.md",
      contextPaths: [
        "/research/notes.md",
        "/research/paper.pdf",
      ],
      webSearchAvailable: true,
    });

    expect(prompt).toContain("You are the verifier");
    expect(prompt).toContain("/tmp/run/proposer.md");
    expect(prompt).toContain("The peer feed may end with an incomplete streamed message");
    expect(prompt).toContain("V3_STATUS: CONTINUE");
    expect(prompt).toContain("V3_STATUS: DONE");
    expect(prompt).toContain("Do not edit either debate feed");
    expect(prompt).toContain("User-selected context sources");
    expect(prompt).toContain("/research/notes.md");
    expect(prompt).toContain("/research/paper.pdf");
    expect(prompt).toContain("Read the relevant sources");
    expect(prompt).toContain("web_search");
    expect(prompt).toContain("Cite source URLs");
  });
});
