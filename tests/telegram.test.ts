import { describe, expect, test } from "bun:test";

import {
  TelegramProgressReporter,
  renderParticipantMessage,
  telegramConfigFromEnv,
} from "../src/telegram";

describe("telegramConfigFromEnv", () => {
  test("is optional but requires both values when enabled", () => {
    expect(telegramConfigFromEnv({})).toBeUndefined();
    expect(telegramConfigFromEnv({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_CHAT_ID: "@debate_stream",
    })).toEqual({
      token: "secret",
      chatId: "@debate_stream",
    });
    expect(() => telegramConfigFromEnv({
      TELEGRAM_BOT_TOKEN: "secret",
    })).toThrow("TELEGRAM_CHAT_ID");
  });
});

describe("renderParticipantMessage", () => {
  test("uses modest HTML while escaping streamed content", () => {
    expect(renderParticipantMessage({
      participant: "proposer",
      text: "Use A < B & keep checking.",
      status: "CONTINUE",
      elapsedMs: 2_500,
      aborted: false,
    })).toBe([
      "<b>PROPOSER</b> · <i>continue · 2.5s</i>",
      "<blockquote>Use A &lt; B &amp; keep checking.</blockquote>",
    ].join("\n"));
  });

  test("keeps long stream updates within a conservative message size", () => {
    const rendered = renderParticipantMessage({
      participant: "verifier",
      text: "x".repeat(5_000),
      status: undefined,
      elapsedMs: undefined,
      aborted: false,
    });

    expect(rendered.length).toBeLessThan(4_096);
    expect(rendered).toContain("…");
    expect(rendered.endsWith("</blockquote>")).toBeTrue();
  });
});

describe("TelegramProgressReporter", () => {
  test("sends an activation post and edits it with the completed stream", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const fakeFetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      const method = url.split("/").at(-1) ?? "";
      if (typeof init?.body !== "string") throw new Error("expected JSON body");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ method, body });
      return Promise.resolve(Response.json({
        ok: true,
        result: { message_id: 42 },
      }));
    };
    const reporter = new TelegramProgressReporter({
      token: "secret",
      chatId: "@debate_stream",
      fetch: fakeFetch,
      updateIntervalMs: 60_000,
      minRequestIntervalMs: 0,
    });

    reporter.handle({
      type: "participant_started",
      participant: "proposer",
      trigger: "initial",
    });
    reporter.handle({
      type: "participant_text",
      participant: "proposer",
      delta: "Draft <one>",
    });
    reporter.handle({
      type: "participant_text",
      participant: "proposer",
      delta: " is ready.",
    });
    reporter.handle({
      type: "participant_completed",
      participant: "proposer",
      status: "DONE",
      elapsedMs: 1_200,
      aborted: false,
    });
    await reporter.close();

    expect(calls.map((call) => call.method)).toEqual([
      "sendMessage",
      "editMessageText",
    ]);
    expect(calls[0]?.body).toMatchObject({
      chat_id: "@debate_stream",
      parse_mode: "HTML",
    });
    expect(calls[1]?.body).toMatchObject({
      chat_id: "@debate_stream",
      message_id: 42,
      parse_mode: "HTML",
      text: [
        "<b>PROPOSER</b> · <i>done · 1.2s</i>",
        "<blockquote>Draft &lt;one&gt; is ready.</blockquote>",
      ].join("\n"),
    });
  });

  test("reports Telegram failure once without rejecting the debate", async () => {
    const warnings: string[] = [];
    const reporter = new TelegramProgressReporter({
      token: "secret",
      chatId: "@debate_stream",
      fetch: () => Promise.resolve(Response.json({
        ok: false,
        description: "Forbidden: bot is not an administrator",
      })),
      minRequestIntervalMs: 0,
      onWarning(message) {
        warnings.push(message);
      },
    });

    reporter.handle({
      type: "participant_started",
      participant: "verifier",
      trigger: "peer_growth",
    });
    await reporter.close();

    expect(warnings).toEqual([
      "Telegram streaming disabled: Forbidden: bot is not an administrator",
    ]);
  });
});
