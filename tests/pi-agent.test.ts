import { describe, expect, test } from "bun:test";

import { participantProtocolPrompt } from "../src/pi-agent";

describe("participantProtocolPrompt", () => {
  test("gives each participant its role, peer feed, and completion markers", () => {
    const prompt = participantProtocolPrompt({
      participant: "verifier",
      peerFeedPath: "/tmp/run/proposer.md",
    });

    expect(prompt).toContain("You are the verifier");
    expect(prompt).toContain("/tmp/run/proposer.md");
    expect(prompt).toContain("The peer feed may end with an incomplete streamed message");
    expect(prompt).toContain("V3_STATUS: CONTINUE");
    expect(prompt).toContain("V3_STATUS: DONE");
    expect(prompt).toContain("Do not edit either debate feed");
  });
});
