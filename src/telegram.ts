import {
  type DebateProgressEvent,
  type DebateStatus,
  type ParticipantName,
} from "./live-feed";

export interface TelegramConfig {
  token: string;
  chatId: string;
}

export type TelegramFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TelegramProgressReporterOptions extends TelegramConfig {
  fetch?: TelegramFetch;
  updateIntervalMs?: number;
  minRequestIntervalMs?: number;
  onWarning?: (message: string) => void;
}

export interface TelegramRunInput {
  topic: string;
  model: string;
  maxDurationMs: number;
}

interface ParticipantMessageInput {
  participant: ParticipantName;
  text: string;
  status: DebateStatus | undefined;
  elapsedMs: number | undefined;
  aborted: boolean;
}

interface ActivationState extends ParticipantMessageInput {
  messageId: number | undefined;
  revision: number;
  flushedRevision: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface TelegramApiResponse {
  ok: boolean;
  description?: string;
  result?: {
    message_id?: number;
  };
}

const DEFAULT_UPDATE_INTERVAL_MS = 1_500;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 1_100;
const MAX_BODY_CODEPOINTS = 3_000;

export function telegramConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): TelegramConfig | undefined {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (token === undefined && chatId === undefined) return undefined;
  if (token === undefined || token.length === 0) {
    throw new Error("TELEGRAM_BOT_TOKEN is required when Telegram streaming is enabled");
  }
  if (chatId === undefined || chatId.length === 0) {
    throw new Error("TELEGRAM_CHAT_ID is required when Telegram streaming is enabled");
  }
  return { token, chatId };
}

export function renderParticipantMessage(
  input: ParticipantMessageInput,
): string {
  const state = input.elapsedMs === undefined
    ? "streaming"
    : [
        input.aborted
          ? "aborted"
          : input.status?.toLowerCase() ?? "finished",
        formatSeconds(input.elapsedMs),
      ].join(" · ");
  const body = tailGraphemes(
    input.text.length === 0 ? "[Waiting for assistant text.]" : input.text,
    MAX_BODY_CODEPOINTS,
  );
  const role = input.participant === "proposer"
    ? "🟦 <b>PROPOSER →</b>"
    : "<b>← VERIFIER</b> 🟧";
  return [
    `${role} · <i>${state}</i>`,
    `<blockquote>${escapeHtml(body)}</blockquote>`,
  ].join("\n");
}

export class TelegramProgressReporter {
  private readonly fetch: TelegramFetch;
  private readonly token: string;
  private readonly chatId: string;
  private readonly updateIntervalMs: number;
  private readonly minRequestIntervalMs: number;
  private readonly onWarning: ((message: string) => void) | undefined;
  private readonly active = new Map<ParticipantName, ActivationState>();
  private pending: Promise<void> = Promise.resolve();
  private nextRequestAtMs = 0;
  private disabled = false;
  private closed = false;

  constructor(options: TelegramProgressReporterOptions) {
    if (options.token.trim().length === 0) throw new Error("Telegram token is required");
    if (options.chatId.trim().length === 0) throw new Error("Telegram chat ID is required");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.token = options.token;
    this.chatId = options.chatId;
    this.updateIntervalMs = nonNegativeNumber(
      options.updateIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS,
      "Telegram update interval",
    );
    this.minRequestIntervalMs = nonNegativeNumber(
      options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS,
      "Telegram request interval",
    );
    this.onWarning = options.onWarning;
  }

  startRun(input: TelegramRunInput): void {
    if (this.closed || this.disabled) return;
    const text = [
      "<b>Heated Debate v3</b>",
      escapeHtml(input.topic),
      `<code>${escapeHtml(input.model)}</code> · ${formatSeconds(input.maxDurationMs)} cap`,
    ].join("\n");
    this.enqueue(async () => {
      await this.sendMessage(text);
    });
  }

  handle(event: DebateProgressEvent): void {
    if (this.closed || this.disabled) return;
    if (event.type === "participant_started") {
      this.startActivation(event.participant);
      return;
    }

    const state = this.active.get(event.participant);
    if (state === undefined) return;
    if (event.type === "participant_text") {
      state.text += event.delta;
      state.revision += 1;
      this.scheduleFlush(state);
      return;
    }

    state.status = event.status;
    state.elapsedMs = event.elapsedMs;
    state.aborted = event.aborted;
    state.revision += 1;
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.enqueueFlush(state);
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.pending;
      return;
    }
    this.closed = true;
    for (const state of this.active.values()) {
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      this.enqueueFlush(state);
    }
    await this.pending;
  }

  private startActivation(participant: ParticipantName): void {
    const state: ActivationState = {
      participant,
      text: "",
      status: undefined,
      elapsedMs: undefined,
      aborted: false,
      messageId: undefined,
      revision: 0,
      flushedRevision: -1,
      timer: undefined,
    };
    this.active.set(participant, state);
    const initialText = renderParticipantMessage(state);
    this.enqueue(async () => {
      state.messageId = await this.sendMessage(initialText);
      state.flushedRevision = 0;
    });
  }

  private scheduleFlush(state: ActivationState): void {
    if (state.timer !== undefined) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.enqueueFlush(state);
    }, this.updateIntervalMs);
  }

  private enqueueFlush(state: ActivationState): void {
    this.enqueue(async () => {
      if (
        state.messageId === undefined
        || state.flushedRevision >= state.revision
      ) {
        return;
      }
      const revision = state.revision;
      await this.editMessage(state.messageId, renderParticipantMessage(state));
      state.flushedRevision = revision;
    });
  }

  private enqueue(operation: () => Promise<void>): void {
    if (this.disabled) return;
    this.pending = this.pending.then(async () => {
      if (this.disabled) return;
      try {
        await operation();
      } catch (error) {
        this.disabled = true;
        this.onWarning?.(`Telegram streaming disabled: ${errorMessage(error)}`);
      }
    });
  }

  private async sendMessage(text: string): Promise<number> {
    const response = await this.request("sendMessage", {
      chat_id: this.chatId,
      parse_mode: "HTML",
      text,
    });
    const messageId = response.result?.message_id;
    if (messageId === undefined) {
      throw new Error("Bot API response did not include a message ID");
    }
    return messageId;
  }

  private async editMessage(messageId: number, text: string): Promise<void> {
    await this.request("editMessageText", {
      chat_id: this.chatId,
      message_id: messageId,
      parse_mode: "HTML",
      text,
    });
  }

  private async request(
    method: "sendMessage" | "editMessageText",
    body: Record<string, unknown>,
  ): Promise<TelegramApiResponse> {
    const waitMs = Math.max(0, this.nextRequestAtMs - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    this.nextRequestAtMs = Date.now() + this.minRequestIntervalMs;

    let response: Response;
    try {
      response = await this.fetch(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new Error("Bot API request failed");
    }

    let data: TelegramApiResponse;
    try {
      data = await response.json() as TelegramApiResponse;
    } catch {
      throw new Error("Bot API returned an unreadable response");
    }
    if (!response.ok || !data.ok) {
      throw new Error(data.description ?? `Bot API returned HTTP ${String(response.status)}`);
    }
    return data;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function tailGraphemes(value: string, limit: number): string {
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
    (part) => part.segment,
  );
  if (graphemes.length <= limit) return value;
  return `…\n${graphemes.slice(-(limit - 2)).join("")}`;
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
