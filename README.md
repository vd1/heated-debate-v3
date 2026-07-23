# Heated Debate v3

Heated Debate v3 runs a proposer and verifier as persistent Pi sessions over two
growing Markdown feeds. There are no rounds. Each participant uses ordinary Pi
tools to pull the other participant's feed and may react while a message is still
streaming.

## Run it

Install dependencies, start Pi in this repository, and invoke:

```text
/debate3 Should we use an event log or a relational database?
```

The default safety cap is five minutes. Override it with:

```text
/debate3 --max-minutes 1.5 Compare approach A with approach B
```

The extension uses the host session's active model and thinking level for both
participants.

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
when the safety cap expires, when a participant fails, or when the host Pi
session shuts down.

## Development

```bash
bun test
bun run typecheck
bun run lint
```

Unit tests use fake participants and do not contact a model provider.
