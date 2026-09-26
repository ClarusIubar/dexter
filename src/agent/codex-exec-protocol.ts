import { parseJsonWithoutDuplicateKeys } from './unique-json.js';

export interface CodexToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface CodexConversationMessage {
  readonly role: string;
  readonly content: unknown;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly unknown[];
}

export interface CodexToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export type CodexModelOutput =
  | { readonly kind: 'final'; readonly content: string }
  | { readonly kind: 'tool_calls'; readonly toolCalls: readonly CodexToolCall[] };

export interface CodexUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface CodexExecResult {
  readonly finalText: string;
  readonly threadId: string | null;
  readonly usage: CodexUsage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function buildCodexOutputSchema(tools: readonly CodexToolSpec[]): Record<string, unknown> {
  const hasTools = tools.length > 0;
  return {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: hasTools ? ['final', 'tool_calls'] : ['final'] },
      content: { type: ['string', 'null'] },
      tool_calls: hasTools
        ? {
            type: ['array', 'null'],
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string', enum: tools.map((tool) => tool.name) },
                // Keep arbitrary Zod inputs out of the provider's restricted schema subset.
                // The original Dexter Agent validates the decoded value against the real tool schema.
                arguments: { type: 'string' },
              },
              required: ['id', 'name', 'arguments'],
              additionalProperties: false,
            },
          }
        : { type: 'null' },
    },
    required: ['kind', 'content', 'tool_calls'],
    additionalProperties: false,
  };
}

export function serializeCodexPrompt(
  messages: readonly CodexConversationMessage[],
  tools: readonly CodexToolSpec[],
): string {
  return JSON.stringify({
    protocol: 'dexter-original-agent-model-port-v1',
    instructions: [
      'You are the model-response port for the original Dexter Agent.',
      'The caller owns the agent loop and executes every returned tool call.',
      'Use only the supplied conversation and listed tool schemas.',
      'Return one JSON object matching the required output schema.',
      'For a tool request, return kind=tool_calls and the exact tool name.',
      'Encode each tool arguments object as a JSON string in the arguments field.',
      'For a completed answer, return kind=final, the answer in content, and tool_calls=null.',
      'For tool_calls, set content=null and provide one or more calls.',
      'Do not invoke shell, filesystem, network, browser, or any other tool.',
      'Do not add candidates or facts absent from the supplied conversation.',
    ],
    messages,
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  });
}

export function parseCodexModelOutput(
  text: string,
  tools: readonly CodexToolSpec[],
): CodexModelOutput {
  let value: unknown;
  try {
    value = parseJsonWithoutDuplicateKeys(text);
  } catch {
    throw new Error('Codex output was not JSON');
  }
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('Codex output did not match the model-port envelope');
  }

  if (value.kind === 'final') {
    if (Object.keys(value).some((key) => !['kind', 'content', 'tool_calls'].includes(key))
      || typeof value.content !== 'string' || value.tool_calls !== null) {
      throw new Error('Codex final response was invalid');
    }
    return { kind: 'final', content: value.content };
  }

  if (value.kind !== 'tool_calls'
    || Object.keys(value).some((key) => !['kind', 'content', 'tool_calls'].includes(key))
    || value.content !== null) {
    throw new Error('Codex response kind was unsupported');
  }
  if (!Array.isArray(value.tool_calls) || value.tool_calls.length === 0) {
    throw new Error('Codex tool-call response was empty');
  }

  const allowedTools = new Set(tools.map((tool) => tool.name));
  const ids = new Set<string>();
  const toolCalls = value.tool_calls.map((raw): CodexToolCall => {
    if (!isRecord(raw)
      || Object.keys(raw).some((key) => key !== 'id' && key !== 'name' && key !== 'arguments')
      || typeof raw.id !== 'string'
      || raw.id.trim().length === 0
      || typeof raw.name !== 'string'
      || !allowedTools.has(raw.name)
      || typeof raw.arguments !== 'string') {
      throw new Error('Codex tool-call response contained an invalid call');
    }
    if (ids.has(raw.id)) {
      throw new Error('Codex tool-call response contained a duplicate call id');
    }
    let args: unknown;
    try {
      args = parseJsonWithoutDuplicateKeys(raw.arguments);
    } catch {
      throw new Error('Codex tool-call arguments were not JSON');
    }
    if (!isRecord(args)) throw new Error('Codex tool-call arguments were not an object');
    ids.add(raw.id);
    return { id: raw.id, name: raw.name, arguments: args };
  });
  return { kind: 'tool_calls', toolCalls };
}

function normalizeUsage(value: unknown): CodexUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens)
    || (inputTokens as number) < 0 || (outputTokens as number) < 0) {
    return null;
  }
  const totalTokens = Number.isInteger(value.total_tokens)
    ? value.total_tokens as number
    : (inputTokens as number) + (outputTokens as number);
  if (totalTokens < 0) return null;
  return { inputTokens: inputTokens as number, outputTokens: outputTokens as number, totalTokens };
}

export class CodexExecEventAccumulator {
  private finalText: string | null = null;
  private threadId: string | null = null;
  private usage: CodexUsage | null = null;
  private threadStarted = false;
  private turnStarted = false;
  private completed = false;
  private finalMessageCount = 0;

  accept(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let event: unknown;
    try {
      event = parseJsonWithoutDuplicateKeys(trimmed);
    } catch {
      throw new Error('Codex emitted a malformed JSONL event');
    }
    if (!isRecord(event) || typeof event.type !== 'string') {
      throw new Error('Codex emitted an invalid JSONL event');
    }

    if (event.type === 'thread.started') {
      if (this.threadStarted || this.turnStarted || typeof event.thread_id !== 'string' || event.thread_id.length === 0) {
        throw new Error('Codex thread id was invalid');
      }
      this.threadStarted = true;
      this.threadId = event.thread_id;
      return;
    }
    if (event.type === 'turn.started') {
      if (!this.threadStarted || this.turnStarted || this.completed) throw new Error('Codex turn lifecycle was invalid');
      this.turnStarted = true;
      return;
    }
    if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
      if (!this.turnStarted || this.completed || !isRecord(event.item) || typeof event.item.type !== 'string') {
        throw new Error('Codex emitted an invalid item event');
      }
      if (event.item.type === 'reasoning') return;
      if (event.item.type !== 'agent_message') {
        throw new Error('Codex attempted a non-message action');
      }
      if (event.type === 'item.completed') {
        if (typeof event.item.text !== 'string' || ++this.finalMessageCount !== 1) {
          throw new Error('Codex agent message was invalid');
        }
        this.finalText = event.item.text;
      }
      return;
    }
    if (event.type === 'turn.completed') {
      if (!this.turnStarted || this.completed || this.finalMessageCount !== 1) {
        throw new Error('Codex turn lifecycle was invalid');
      }
      this.usage = normalizeUsage(event.usage);
      if (!this.usage) throw new Error('Codex turn usage was invalid');
      this.completed = true;
      return;
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      throw new Error('Codex turn failed');
    }
    throw new Error('Codex emitted an unsupported event');
  }

  result(): CodexExecResult {
    if (!this.completed || this.finalText === null || this.usage === null) {
      throw new Error('Codex turn did not complete with a response and usage');
    }
    return { finalText: this.finalText, threadId: this.threadId, usage: this.usage };
  }
}
