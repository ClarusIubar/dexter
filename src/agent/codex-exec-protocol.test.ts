import { describe, expect, test } from 'bun:test';
import {
  buildCodexOutputSchema,
  CodexExecEventAccumulator,
  CodexProtocolError,
  parseCodexModelOutput,
  serializeCodexPrompt,
  type CodexToolSpec,
} from './codex-exec-protocol.js';

const tools: CodexToolSpec[] = [
  {
    name: 'frozen.lookup',
    description: 'Read one frozen fixture value.',
    inputSchema: {
      type: 'object',
      properties: { ticker: { type: 'string' } },
      required: ['ticker'],
      additionalProperties: false,
    },
  },
];

describe('Codex model-port protocol', () => {
  test('builds a final-only schema when no tools are available', () => {
    const schema = buildCodexOutputSchema([]);
    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        kind: { enum: ['final'] },
        content: { type: ['string', 'null'] },
        tool_calls: { type: 'null' },
      },
      required: ['kind', 'content', 'tool_calls'],
      additionalProperties: false,
    });
  });

  test('uses one strict envelope and binds calls to exact allowlisted names', () => {
    const schema = buildCodexOutputSchema(tools);
    expect(schema).toMatchObject({
      properties: {
        kind: { enum: ['final', 'tool_calls'] },
        tool_calls: {
          type: ['array', 'null'],
          items: {
            properties: {
              name: { enum: ['frozen.lookup'] },
              arguments: { type: 'string' },
            },
          },
        },
      },
      required: ['kind', 'content', 'tool_calls'],
      additionalProperties: false,
    });
  });

  test('serializes the exact conversation and allowed tool set', () => {
    const prompt = serializeCodexPrompt([{ role: 'user', content: 'lookup AAPL' }], tools);
    expect(JSON.parse(prompt)).toMatchObject({
      protocol: 'dexter-original-agent-model-port-v1',
      messages: [{ role: 'user', content: 'lookup AAPL' }],
      tools: [{ name: 'frozen.lookup', inputSchema: tools[0].inputSchema }],
    });
  });

  test('parses a final response without coercing prose or extra fields', () => {
    expect(parseCodexModelOutput('{"kind":"final","content":"done","tool_calls":null}', tools)).toEqual({
      kind: 'final',
      content: 'done',
    });
    expect(() => parseCodexModelOutput('{"kind":"final","content":"done","tool_calls":null,"ticker":"AAPL"}', tools)).toThrow();
    expect(() => parseCodexModelOutput('Here is the JSON: {"kind":"final","content":"done","tool_calls":null}', tools)).toThrow();
    expect(() => parseCodexModelOutput('{"kind":"final","kind":"tool_calls","content":"done","tool_calls":null}', tools)).toThrow();
  });

  test('accepts only unique calls to allowlisted tools with object arguments', () => {
    expect(parseCodexModelOutput(
      '{"kind":"tool_calls","content":null,"tool_calls":[{"id":"call-1","name":"frozen.lookup","arguments":"{\\"ticker\\":\\"AAPL\\"}"}]}',
      tools,
    )).toEqual({
      kind: 'tool_calls',
      toolCalls: [{ id: 'call-1', name: 'frozen.lookup', arguments: { ticker: 'AAPL' } }],
    });
    expect(() => parseCodexModelOutput(
      '{"kind":"tool_calls","content":null,"tool_calls":[{"id":"call-1","name":"web_search","arguments":"{}"}]}',
      tools,
    )).toThrow();
    expect(() => parseCodexModelOutput(
      '{"kind":"tool_calls","content":null,"tool_calls":[{"id":"call-1","name":"frozen.lookup","arguments":"{}"},{"id":"call-1","name":"frozen.lookup","arguments":"{}"}]}',
      tools,
    )).toThrow();
    expect(() => parseCodexModelOutput(
      '{"kind":"tool_calls","content":null,"tool_calls":[{"id":"call-1","name":"frozen.lookup","arguments":"{\\"ticker\\":\\"AAPL\\",\\"ticker\\":\\"MSFT\\"}"}]}',
      tools,
    )).toThrow();
  });

  test('captures the agent message and usage and rejects native command execution', () => {
    const events = new CodexExecEventAccumulator();
    events.accept('{"type":"thread.started","thread_id":"thread-1"}');
    events.accept('{"type":"turn.started"}');
    events.accept('{"type":"item.started","item":{"type":"reasoning"}}');
    events.accept('{"type":"item.completed","item":{"type":"agent_message","text":"{\\"kind\\":\\"final\\",\\"content\\":\\"ok\\",\\"tool_calls\\":null}"}}');
    events.accept('{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":2,"total_tokens":14}}');
    expect(events.result()).toEqual({
      finalText: '{"kind":"final","content":"ok","tool_calls":null}',
      threadId: 'thread-1',
      usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
    });
    const blocked = new CodexExecEventAccumulator();
    expect(() => blocked.accept('{"type":"item.started","item":{"type":"command_execution"}}')).toThrow();
    expect(() => blocked.accept('{"type":"thread.started","type":"item.completed","thread_id":"thread-1"}')).toThrow();
    expect(() => blocked.accept('{"type":"turn.started"}')).toThrow();
  });
});


const startupWarning = { type: 'item.completed', item: { id: 'diagnostic-0', type: 'error',
  message: 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.' } };
const feed = (acc: CodexExecEventAccumulator, event: unknown) => acc.accept(JSON.stringify(event));
const startThread = (acc: CodexExecEventAccumulator) => feed(acc, { type: 'thread.started', thread_id: 'fixture' });
const finishTurn = (acc: CodexExecEventAccumulator) => {
  feed(acc, { type: 'turn.started' });
  feed(acc, { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } });
  feed(acc, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } });
};
test('accepts only the observed once-only startup notice and preserves diagnostic code with usage', () => {
  const acc = new CodexExecEventAccumulator(); startThread(acc); feed(acc, startupWarning); finishTurn(acc);
  expect(acc.result()).toMatchObject({ finalText: 'ok', diagnostics: ['code_mode_disabled'], usage: { totalTokens: 3 } });
});
for (const [name, event] of [
  ['unknown', { ...startupWarning, item: { ...startupWarning.item, message: 'another error' } }],
  ['empty id', { ...startupWarning, item: { ...startupWarning.item, id: '' } }],
  ['oversized id', { ...startupWarning, item: { ...startupWarning.item, id: 'x'.repeat(257) } }],
  ['extra item key', { ...startupWarning, item: { ...startupWarning.item, payload: 'untrusted' } }],
  ['extra event key', { ...startupWarning, payload: 'untrusted' }],
  ['wrong event', { ...startupWarning, type: 'item.updated' }],
] as const) {
  test(`startup notice fails closed: ${name}`, () => {
    const acc = new CodexExecEventAccumulator(); startThread(acc);
    try { feed(acc, event); throw new Error('accepted'); } catch (error) {
      expect(error).toBeInstanceOf(CodexProtocolError);
      expect((error as CodexProtocolError).kind).toBe(name === 'unknown' ? 'readiness' : 'integrity');
    }
    expect(() => acc.result()).toThrow();
  });
}
for (const position of ['before thread', 'duplicate', 'in turn', 'after completion']) {
  test(`startup notice rejected ${position}`, () => {
    const acc = new CodexExecEventAccumulator();
    if (position !== 'before thread') startThread(acc);
    if (position === 'duplicate') feed(acc, startupWarning);
    if (position === 'in turn') feed(acc, { type: 'turn.started' });
    if (position === 'after completion') finishTurn(acc);
    expect(() => feed(acc, startupWarning)).toThrow('codex_startup_diagnostic_invalid');
  });
}
for (const tail of ['{"type":"item.started","item":{"type":"command_execution"}}', '{"type":"turn.started","type":"turn.started"}', '{broken']) {
  test(`startup warning cannot authorize unsafe tail ${tail}`, () => {
    const acc = new CodexExecEventAccumulator(); startThread(acc); feed(acc, startupWarning);
    expect(() => acc.accept(tail)).toThrow();
    expect(() => acc.result()).toThrow();
  });
}
