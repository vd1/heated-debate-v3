# Heated Debate v3 plan

## Goal

Explore a continuous debate protocol built from persistent Pi sessions and
append-only Markdown feeds. Keep the first implementation small enough to change
after observing real runs. Run Pi as a library from a standalone Bun CLI.

## Protocol

- Maintain a proposer session and a verifier session for the duration of a run.
- Stream each participant's visible text into its own Markdown feed.
- Let each participant pull the other feed with ordinary Pi tools.
- Prod an idle participant when the peer feed grows, including during a partial
  message.
- Include role and feed instructions in each participant's system prompt.
- Give both participants the same explicit list of user-selected context paths.
- Optionally expose source-linked live web search for factual verification.
- Record rough timing in the feed entry written by the master.
- Print a lightweight console line when a participant starts or finishes.
- Optionally mirror streamed activations to Telegram through throttled edits.
- Tell participants approximately how much wall-clock time remains in every prod.
- Stop when both participants declare `V3_STATUS: DONE`, with a wall-clock safety
  cap.

## Initial boundaries

- The Markdown feeds are the debate record.
- There are no rounds, separate event store, replay mechanism, recovery protocol,
  cost model, or moderator model.
- Participant sessions live only for the current run.
- A participant failure stops the run.

## Acceptance

- The verifier can begin reacting before the proposer finishes streaming.
- Both sessions preserve their conversational context across prods.
- Feed entries identify the participant and contain prompt, first-text, and
  completion timing.
- The run records its selected context paths, and missing paths fail before model
  startup.
- Web search is absent without configuration and requires visible source URLs
  when available.
- Telegram failure does not interrupt the debate or replace the local feeds.
- Consensus, timeout, failure, and process interruption dispose both sessions.
