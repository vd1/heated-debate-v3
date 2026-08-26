import { describe, expect, test } from "bun:test";

import {
  createTavilyWebSearchTool,
  tavilyConfigFromEnv,
} from "../src/web-search";

describe("tavilyConfigFromEnv", () => {
  test("enables search only when a key is configured", () => {
    expect(tavilyConfigFromEnv({})).toBeUndefined();
    expect(tavilyConfigFromEnv({ TAVILY_API_KEY: " tvly-secret " })).toEqual({
      apiKey: "tvly-secret",
    });
  });
});

describe("createTavilyWebSearchTool", () => {
  test("returns concise source URLs and excerpts", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const observed: Record<string, unknown> = {};
    const fakeFetch = (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (typeof init?.body !== "string") throw new Error("expected JSON body");
      requestBody = JSON.parse(init.body) as Record<string, unknown>;
      observed.authorization = new Headers(init.headers).get("authorization");
      return Promise.resolve(Response.json({
        results: [
          {
            title: "Primary result",
            url: "https://example.com/evidence",
            content: "The measured result was 42.",
            score: 0.91,
          },
          {
            title: "Corroborating result",
            url: "https://example.org/check",
            content: "An independent source reports the same value.",
            score: 0.82,
          },
        ],
      }));
    };
    const tool = createTavilyWebSearchTool({
      apiKey: "tvly-secret",
      fetch: fakeFetch,
    });

    const result = await tool.execute(
      "call-1",
      { query: "measured result" },
      undefined,
      undefined,
      null as never,
    );

    expect(tool.name).toBe("web_search");
    expect(observed.authorization).toBe("Bearer tvly-secret");
    expect(requestBody).toEqual({
      query: "measured result",
      search_depth: "basic",
      max_results: 5,
      include_answer: false,
    });
    expect(result.content).toEqual([{
      type: "text",
      text: [
        "Search results for: measured result",
        "",
        "1. Primary result",
        "URL: https://example.com/evidence",
        "Excerpt: The measured result was 42.",
        "",
        "2. Corroborating result",
        "URL: https://example.org/check",
        "Excerpt: An independent source reports the same value.",
      ].join("\n"),
    }]);
  });

  test("reports when a search has no results", async () => {
    const tool = createTavilyWebSearchTool({
      apiKey: "tvly-secret",
      fetch: () => Promise.resolve(Response.json({ results: [] })),
    });

    const result = await tool.execute(
      "call-1",
      { query: "obscure claim" },
      undefined,
      undefined,
      null as never,
    );

    expect(result.content).toEqual([{
      type: "text",
      text: "No web results found for: obscure claim",
    }]);
  });
});
