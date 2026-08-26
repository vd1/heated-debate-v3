import { describe, expect, test } from "bun:test";

import { participantProtocolPrompt } from "../src/pi-agent";

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
