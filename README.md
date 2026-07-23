# Heated Debate v3

Heated Debate v3 runs a proposer and verifier as persistent Pi sessions over two
growing Markdown feeds. There are no rounds. Each participant uses ordinary Pi
tools to pull the other participant's feed and may react while a message is still
streaming. Pi is used as a library by a standalone Bun process.

## Run it

Install dependencies and run:

```bash
bun run debate "Should we use an event log or a relational database?"
```

The default safety cap is five minutes. Override it with:

```bash
bun run debate --max-minutes 1.5 "Compare approach A with approach B"
```

The default model is `openai-codex/gpt-5.6-sol` with thinking level `high`.
Override either setting with `--model provider/model` or `--thinking LEVEL`.
Both participants use the same selection.

The process prints a short line when either participant starts or finishes:

```text
[2026-07-23T10:30:00.000Z] verifier started (peer update)
[2026-07-23T10:30:12.345Z] verifier finished in 12.3s (continue)
```

Every prod includes the approximate time remaining so participants can converge
without rounds. A response interrupted by the safety cap is reported as
`aborted` in both the console and feed.

## Follow it on Telegram

Telegram output is optional. Create a bot with BotFather, add it to the target
channel with permission to post, then provide its token and the channel ID:

```bash
TELEGRAM_BOT_TOKEN="..." \
TELEGRAM_CHAT_ID="@channel_name" \
bun run debate "Should we use an event log or a relational database?"
```

`TELEGRAM_CHAT_ID` may also be a numeric chat ID. The CLI sends a short run
header, then creates a lightly formatted post for each participant activation.
It edits that post at a throttled cadence while text arrives and flushes the
final status when the activation completes. Long activations show their latest
text in Telegram; the full stream remains in the local Markdown feed.

Telegram delivery is kept outside the debate control path. A Bot API or
permission error prints a warning, disables further Telegram output for that
run, and lets the debate continue.

## Output

Each run creates:

```text
runs/run-XXXXXX/
  topic.md
  proposer.md
  verifier.md
```

The master appends visible assistant text to the appropriate feed as Pi emits
text deltas. Feed entries contain rough prompt, first-text, and completion timing.
The feeds are the debate record.

Each participant finishes a response with `V3_STATUS: CONTINUE` or
`V3_STATUS: DONE`. The run stops when both latest completed responses say `DONE`,
when the safety cap expires, when a participant fails, or when the standalone
process receives an interrupt.

## Development

```bash
bun test
bun run typecheck
bun run lint
```

Unit tests use fake participants and do not contact a model provider.
