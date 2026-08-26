import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface TavilyConfig {
  apiKey: string;
}

export type WebSearchFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TavilyWebSearchOptions extends TavilyConfig {
  fetch?: WebSearchFetch;
}

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
}

interface TavilyResponse {
  results?: unknown;
  detail?: unknown;
}

const WebSearchParameters = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 400,
    description: "A focused factual search query",
  }),
}, { additionalProperties: false });

export function tavilyConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): TavilyConfig | undefined {
  const apiKey = env.TAVILY_API_KEY?.trim();
  return apiKey === undefined || apiKey.length === 0 ? undefined : { apiKey };
}

export function createTavilyWebSearchTool(
  options: TavilyWebSearchOptions,
) {
  const fetchSearch = options.fetch ?? globalThis.fetch;
  return defineTool({
    name: "web_search",
    label: "Web search",
    description: [
      "Search the live web for factual verification.",
      "Returns source titles, URLs, and excerpts.",
      "Use focused queries and cite the returned URLs in visible debate text.",
    ].join(" "),
    promptSnippet: "Search the live web for current or disputed facts",
    promptGuidelines: [
      "Use web_search when a factual claim is current, uncertain, or disputed.",
      "Cite the returned source URLs in your visible response.",
    ],
    parameters: WebSearchParameters,
    async execute(_toolCallId, params, signal) {
      const query = params.query.trim();
      if (query.length === 0) throw new Error("web search query is required");
      const data = await requestTavily(
        fetchSearch,
        options.apiKey,
        query,
        signal,
      );
      const results = parseResults(data.results);
      const text = results.length === 0
        ? `No web results found for: ${query}`
        : formatResults(query, results);
      return {
        content: [{ type: "text", text }],
        details: {
          query,
          resultCount: results.length,
        },
      };
    },
  });
}

async function requestTavily(
  fetchSearch: WebSearchFetch,
  apiKey: string,
  query: string,
  signal: AbortSignal | undefined,
): Promise<TavilyResponse> {
  let response: Response;
  try {
    response = await fetchSearch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: 5,
        include_answer: false,
      }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new Error("Tavily search request failed");
  }

  let data: TavilyResponse;
  try {
    data = await response.json() as TavilyResponse;
  } catch {
    throw new Error("Tavily returned an unreadable response");
  }
  if (!response.ok) {
    const detail = typeof data.detail === "string" ? `: ${data.detail}` : "";
    throw new Error(`Tavily search failed with HTTP ${String(response.status)}${detail}`);
  }
  return data;
}

function parseResults(value: unknown): TavilyResult[] {
  if (!Array.isArray(value)) return [];
  return value.filter((result): result is TavilyResult => (
    typeof result === "object"
    && result !== null
    && typeof (result as TavilyResult).title === "string"
    && typeof (result as TavilyResult).url === "string"
    && typeof (result as TavilyResult).content === "string"
  )).slice(0, 5);
}

function formatResults(query: string, results: readonly TavilyResult[]): string {
  return [
    `Search results for: ${query}`,
    "",
    ...results.flatMap((result, index) => [
      `${String(index + 1)}. ${String(result.title)}`,
      `URL: ${String(result.url)}`,
      `Excerpt: ${conciseExcerpt(String(result.content))}`,
      ...(index === results.length - 1 ? [] : [""]),
    ]),
  ].join("\n");
}

function conciseExcerpt(value: string): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  return normalized.length <= 1_000
    ? normalized
    : `${normalized.slice(0, 999)}…`;
}
