import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, expect, test } from 'bun:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { CodexExecModelPort, CodexModelPortError, containedCodexCommand } from './codex-exec-model-port.ts';

const TEMP_ROOT = path.resolve('.tmp-exp001-model-port-tests');
afterAll(() => rmSync(TEMP_ROOT, { recursive: true, force: true }));

const macTest = test.skipIf(process.platform !== 'darwin');

function fixture(execBody: string, maxOutputBytes = 128, authBody = '') {
  mkdirSync(TEMP_ROOT, { recursive: true });
  const root = mkdtempSync(path.join(TEMP_ROOT, 'case-'));
  const binaryPath = path.join(root, 'fake-codex');
  const binary = `#!${process.execPath}\nif (process.argv.slice(2).join(' ') === 'login status') {\n  ${authBody}\n  process.stdout.write('Logged in using ChatGPT\\n');\n  process.exit(0);\n}\n${execBody}\n`;
  writeFileSync(binaryPath, binary, { mode: 0o700 });
  chmodSync(binaryPath, 0o700);
  const workRoot = path.join(root, 'work-root-not-created-yet');
  const port = new CodexExecModelPort({ binaryPath,
    expectedBinarySha256: createHash('sha256').update(binary).digest('hex'),
    workRoot, timeoutMs: 5_000, reasoningEffort: 'low', maxOutputBytes });
  return { root, binaryPath, workRoot, port, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

macTest('creates a new work root before checking ChatGPT authentication', async () => {
  const f = fixture('process.exit(0);');
  try {
    let failure: unknown;
    try { await f.port.invoke({ messages: [], tools: [], model: 'gpt-6-sol' }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CodexModelPortError);
    expect((failure as CodexModelPortError).kind).toBe('integrity');
    expect((failure as Error).message).toMatch(/Codex turn did not complete/);
    expect(existsSync(f.workRoot)).toBe(true);
  } finally { f.cleanup(); }
});

macTest('prompt write failure is reported even when the child emits a valid response', async () => {
  const events = [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: '{"kind":"final","content":"ok","tool_calls":null}' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n';
  const f = fixture(`process.stdin.destroy();\nprocess.stdout.write(${JSON.stringify(events)});`, 4_096);
  try {
    let failure: unknown;
    try {
      await f.port.invoke({ messages: [new HumanMessage('x'.repeat(2 * 1024 * 1024))], tools: [], model: 'gpt-6-sol' });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CodexModelPortError);
    expect((failure as CodexModelPortError).kind).toBe('operational');
    expect((failure as Error).message).toMatch(/codex_prompt_write_failed/);
  } finally { f.cleanup(); }
});

macTest('integrity failure stays primary when a later output chunk exceeds the limit', async () => {
  const body = `process.on('SIGTERM', () => {});\nprocess.stdout.write('{"type":"item.started","item":{"type":"command_execution"}}\\n', () => {\n  setTimeout(() => process.stdout.write('x'.repeat(1024)), 100);\n});\nsetInterval(() => {}, 1000);`;
  const f = fixture(body);
  try {
    let failure: unknown;
    try { await f.port.invoke({ messages: [], tools: [], model: 'gpt-6-sol' }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CodexModelPortError);
    expect((failure as CodexModelPortError).kind).toBe('integrity');
    expect((failure as Error).message).toMatch(/invalid item event/);
  } finally { f.cleanup(); }
});


macTest('serializes the Agent tool conversation and validates returned Zod arguments', async () => {
  const output = { kind: 'tool_calls', content: null, tool_calls: [
    { id: 'next-call', name: 'frozen.lookup', arguments: JSON.stringify({ ticker: 'AAPL' }) },
  ] };
  const events = [
    { type: 'thread.started', thread_id: 'thread-tools' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } },
    { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n';
  const f = fixture(`let prompt = ''; process.stdin.on('data', chunk => { prompt += chunk; });
    process.stdin.on('end', () => {
      const messages = JSON.parse(prompt).messages;
      if (messages[0].role !== 'user' || messages[1].toolCalls[0].id !== 'prior-call'
        || messages[2].toolCallId !== 'prior-call' || messages[2].content !== 'frozen result') process.exit(2);
      process.stdout.write(${JSON.stringify(events)});
    });`, 4096);
  const tool = new DynamicStructuredTool({ name: 'frozen.lookup', description: 'Frozen lookup',
    schema: z.object({ ticker: z.string() }).strict(), func: async () => 'unused' });
  try {
    const result = await f.port.invoke({ model: 'gpt-6-sol', tools: [tool], messages: [
      new HumanMessage('rank'),
      new AIMessage({ content: '', tool_calls: [{ id: 'prior-call', name: 'frozen.lookup', args: { ticker: 'AAPL' } }] }),
      new ToolMessage({ content: 'frozen result', tool_call_id: 'prior-call' }),
    ] });
    expect(result.response.tool_calls).toEqual([{ id: 'next-call', name: 'frozen.lookup', args: { ticker: 'AAPL' }, type: 'tool_call' }]);
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  } finally { f.cleanup(); }
});

macTest('rejects a non-Zod tool schema before executing a model request', async () => {
  const f = fixture('process.exit(99);');
  const tool = new DynamicStructuredTool({ name: 'json.lookup', description: 'Unsupported schema',
    schema: { type: 'object', properties: { ticker: { type: 'string' } } } as const, func: async () => 'unused' });
  try {
    let failure: unknown;
    try { await f.port.invoke({ model: 'gpt-6-sol', tools: [tool], messages: [] }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CodexModelPortError);
    expect((failure as CodexModelPortError).kind).toBe('integrity');
    expect((failure as Error).message).toBe('codex_tool_schema_invalid');
  } finally { f.cleanup(); }
});


test('containment command fixes the native sandbox and refuses unsupported platforms', () => {
  for (const args of [['login', 'status'], ['exec', '--json']]) {
    expect(containedCodexCommand('darwin', '/pinned/native-codex', args)).toEqual({
      executable: '/usr/bin/sandbox-exec',
      args: ['-p', '(version 1)(allow default)(deny process-fork)', '/pinned/native-codex', ...args],
    });
  }
  for (const platform of ['linux', 'win32', 'freebsd'] as const) {
    expect(() => containedCodexCommand(platform, '/pinned/native-codex', [])).toThrow('codex_process_containment_unavailable');
  }
});

for (const detached of [false, true]) {
  macTest(`denies ${detached ? 'detached' : 'inherited-stdio'} descendants during auth and exec`, async () => {
    // A spawned process would exit successfully; EPERM must be observed at BOTH entry points.
    const attempt = `const { spawnSync } = require('node:child_process');
      const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { detached: ${detached}, stdio: ${detached ? "'ignore'" : "'inherit'"} });
      if (!result.error || result.error.code !== 'EPERM') process.exit(98);`;
    const events = [
      { type: 'thread.started', thread_id: 'contained' }, { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: '{"kind":"final","content":"contained","tool_calls":null}' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n';
    const f = fixture(`${attempt}
process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(events)}));`, 4096, attempt);
    try {
      const result = await f.port.invoke({ messages: [], tools: [], model: 'gpt-6-sol' });
      expect(result.response.content).toBe('contained');
    } finally { f.cleanup(); }
  });
}

test.skipIf(process.platform === 'darwin')('ModelPort fails closed before filesystem or authentication on unsupported hosts', async () => {
  const port = new CodexExecModelPort({ binaryPath: '/nonexistent-codex', expectedBinarySha256: 'a'.repeat(64),
    workRoot: '/nonexistent-work-root', timeoutMs: 100, reasoningEffort: 'low' });
  await expect(port.invoke({ messages: [], tools: [], model: 'gpt-6-sol' })).rejects.toThrow('codex_process_containment_unavailable');
});
