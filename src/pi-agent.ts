import {
  type AgentSession,
  type CreateAgentSessionOptions,
  type ToolDefinition,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import type {
  DebateAgent,
  ParticipantName,
  TextDeltaHandler,
} from "./live-feed";

type SelectedModel = NonNullable<CreateAgentSessionOptions["model"]>;
type SelectedThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export interface CreatePiDebateAgentsInput {
  cwd: string;
  runDirectory: string;
  model: SelectedModel;
  thinkingLevel: SelectedThinkingLevel;
  contextPaths?: readonly string[];
  customTools?: ToolDefinition[];
  webSearchAvailable?: boolean;
  modelRuntime?: ModelRuntime;
}

export interface PiDebateAgents {
  proposer: DebateAgent;
  verifier: DebateAgent;
}

export class PiDebateAgent implements DebateAgent {
  constructor(private readonly session: AgentSession) {}

  async prompt(prompt: string, onText: TextDeltaHandler): Promise<void> {
    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === "message_update"
        && event.assistantMessageEvent.type === "text_delta") {
        onText(event.assistantMessageEvent.delta);
      }
    });
    try {
      await this.session.prompt(prompt, { expandPromptTemplates: false });
    } finally {
      unsubscribe();
    }
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  dispose(): void {
    this.session.dispose();
  }
}

export async function createPiDebateAgents(
  input: CreatePiDebateAgentsInput,
): Promise<PiDebateAgents> {
  const modelRuntime = input.modelRuntime ?? await ModelRuntime.create();
  const proposerSession = await createParticipantSession({
    ...input,
    participant: "proposer",
    peerFeedPath: `${input.runDirectory}/verifier.md`,
    modelRuntime,
  });

  try {
    const verifierSession = await createParticipantSession({
      ...input,
      participant: "verifier",
      peerFeedPath: `${input.runDirectory}/proposer.md`,
      modelRuntime,
    });
    return {
      proposer: new PiDebateAgent(proposerSession),
      verifier: new PiDebateAgent(verifierSession),
    };
  } catch (error) {
    proposerSession.dispose();
    throw error;
  }
}

export function participantProtocolPrompt(input: {
  participant: ParticipantName;
  peerFeedPath: string;
  contextPaths?: readonly string[];
  webSearchAvailable?: boolean;
}): string {
  const role = input.participant === "proposer"
    ? [
        "Develop the strongest concrete answer to the topic.",
        "Respond to criticism by repairing or replacing weak parts of the proposal.",
      ]
    : [
        "Stress-test the proposal, find unsupported claims and missing constraints, and propose repairs.",
        "Say DONE only when the remaining proposal is adequate.",
      ];
  const context = input.contextPaths?.length
    ? [
        "",
        "User-selected context sources:",
        ...input.contextPaths.map((path) => `- ${path}`),
        "- Read the relevant sources before making claims they can settle.",
      ]
    : [];
  const webSearch = input.webSearchAvailable === true
    ? [
        "",
        "Live verification:",
        "- The web_search tool is available for current, uncertain, or disputed factual claims.",
        "- Cite source URLs in visible responses so the peer and reader can inspect the evidence.",
      ]
    : [];

  return [
    `You are the ${input.participant} in a continuous, asynchronous debate.`,
    ...role,
    ...context,
    ...webSearch,
    "",
    "Protocol:",
    `- On every prod, use your ordinary tools to read the peer feed at ${input.peerFeedPath}.`,
    "- The peer feed may end with an incomplete streamed message. You may respond to useful partial content.",
    "- Your visible assistant text is streamed automatically to your own feed.",
    "- Do not edit either debate feed. The master owns feed writes.",
    "- End every response with exactly one of these lines:",
    "  V3_STATUS: CONTINUE",
    "  V3_STATUS: DONE",
    "- Use DONE only when you believe the debate has reached an adequate shared result.",
  ].join("\n");
}

async function createParticipantSession(input: CreatePiDebateAgentsInput & {
  participant: ParticipantName;
  peerFeedPath: string;
  modelRuntime: ModelRuntime;
}): Promise<AgentSession> {
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: (base) => [
      ...base,
      participantProtocolPrompt(input),
    ],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: input.cwd,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    modelRuntime: input.modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(input.cwd),
    ...(input.customTools === undefined
      ? {}
      : { customTools: input.customTools }),
  });
  return session;
}
