import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { AIMessage, type BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import type { AgentModelPort, TokenUsage } from '../agent/types.js';
import {
  buildCodexOutputSchema,
  CodexExecEventAccumulator,
  parseCodexModelOutput,
  serializeCodexPrompt,
  type CodexToolSpec,
} from '../agent/codex-exec-protocol.js';

const DISABLED_CODEX_FEATURES = [
  'hooks', 'plugins', 'apps', 'memories', 'multi_agent', 'shell_tool', 'unified_exec',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'image_generation',
  'skill_search', 'skill_mcp_dependency_install', 'computer_use', 'remote_plugin',
  'workspace_dependencies', 'request_permissions_tool', 'tool_call_mcp_elicitation',
  'in_app_local_automation', 'in_app_browser', 'standalone_web_search', 'realtime_conversation',
  'auth_elicitation', 'enable_mcp_apps', 'code_mode', 'code_mode_host', 'code_mode_only',
  'unified_exec_tty',
] as const;

export interface CodexExecModelPortOptions {
  readonly binaryPath: string;
  readonly expectedBinarySha256: string;
  readonly workRoot: string;
  readonly timeoutMs: number;
  readonly reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  readonly maxOutputBytes?: number;
}

const CODEX_AUTH_TIMEOUT_MS = 5_000;

export class CodexModelPortError extends Error {
  constructor(readonly kind: 'operational' | 'integrity' | 'readiness', message: string) {
    super(message);
    this.name = 'CodexModelPortError';
  }
}

const SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'CODEX_HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TERM',
  'USER',
  'LOGNAME',
  'XDG_RUNTIME_DIR',
] as const;

function safeCodexEnvironment(requestDirectory: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) safe[key] = value;
  }
  if (!safe.CODEX_HOME && safe.HOME) safe.CODEX_HOME = join(safe.HOME, '.codex');
  safe.TMPDIR = requestDirectory;
  safe.TMP = requestDirectory;
  safe.TEMP = requestDirectory;
  safe.CI = '1';
  return safe;
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return digest.digest('hex');
}

function serializeMessages(messages: readonly BaseMessage[]) {
  return messages.map((message) => {
    const messageType = message._getType();
    const role = messageType === 'human' ? 'user' : messageType;
    const entry: Record<string, unknown> = { role, content: message.content };
    if (message.name) entry.name = message.name;
    if (message instanceof AIMessage && message.tool_calls.length > 0) {
      entry.toolCalls = message.tool_calls;
    }
    if (message instanceof ToolMessage) {
      entry.toolCallId = message.tool_call_id;
    }
    return entry;
  });
}

function toToolSpecs(tools: readonly StructuredToolInterface[]): CodexToolSpec[] {
  return tools.map((tool) => {
    let inputSchema: unknown;
    try {
      inputSchema = z.toJSONSchema(tool.schema);
    } catch {
      throw new Error('A Codex ModelPort tool did not expose a JSON-compatible input schema');
    }
    if (inputSchema === null || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
      throw new Error('A Codex ModelPort tool schema was not an object');
    }
    return {
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: inputSchema as Record<string, unknown>,
    };
  });
}

function toUsage(input: { inputTokens: number; outputTokens: number; totalTokens: number }): TokenUsage {
  return {
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    totalTokens: input.totalTokens,
  };
}

export class CodexExecModelPort implements AgentModelPort {
  private readonly options: CodexExecModelPortOptions;
  private binaryVerification: Promise<void> | null = null;

  constructor(options: CodexExecModelPortOptions) {
    if (!isAbsolute(options.binaryPath)) {
      throw new Error('Codex ModelPort requires an explicit absolute binary path');
    }
    if (!/^[a-f\d]{64}$/i.test(options.expectedBinarySha256)) {
      throw new Error('Codex ModelPort requires a pinned binary SHA-256');
    }
    if (!options.workRoot.startsWith('/') || options.timeoutMs <= 0) {
      throw new Error('Codex ModelPort requires an absolute work root and positive timeout');
    }
    this.options = options;
  }

  async invoke(input: {
    readonly messages: BaseMessage[];
    readonly tools: StructuredToolInterface[];
    readonly model: string;
    readonly signal?: AbortSignal;
  }): Promise<{ response: AIMessage; usage?: TokenUsage }> {
    await mkdir(this.options.workRoot, { recursive: true });
    await this.verifyBinary();
    if (input.signal?.aborted) throw new Error('Codex ModelPort request was cancelled');

    let toolSpecs: CodexToolSpec[];
    try { toolSpecs = toToolSpecs(input.tools); }
    catch { throw new CodexModelPortError('integrity', 'codex_tool_schema_invalid'); }
    const requestDirectory = await this.createRequestDirectory();
    try {
      const schemaPath = join(requestDirectory, 'output.schema.json');
      await writeFile(schemaPath, JSON.stringify(buildCodexOutputSchema(toolSpecs)), { mode: 0o600 });
      const prompt = serializeCodexPrompt(serializeMessages(input.messages), toolSpecs);
      const result = await this.executeCodex(input.model, schemaPath, requestDirectory, prompt, input.signal);
      let parsed: ReturnType<typeof parseCodexModelOutput>;
      try { parsed = parseCodexModelOutput(result.finalText, toolSpecs); }
      catch { throw new CodexModelPortError('integrity', 'codex_response_invalid'); }

      if (parsed.kind === 'final') {
        return {
          response: new AIMessage({
            content: parsed.content,
            response_metadata: { codexThreadId: result.threadId, modelPort: 'codex_exec_json_v1' },
          }),
          usage: toUsage(result.usage),
        };
      }

      const toolMap = new Map(input.tools.map((tool) => [tool.name, tool]));
      const toolCalls = parsed.toolCalls.map((call) => {
        const tool = toolMap.get(call.name);
        if (!tool) throw new CodexModelPortError('integrity', 'codex_tool_not_allowlisted');
        const validation = tool.schema.safeParse(call.arguments);
        if (!validation.success || !isDeepStrictEqual(validation.data, call.arguments)) {
          throw new CodexModelPortError('integrity', 'codex_tool_arguments_invalid');
        }
        return { id: call.id, name: call.name, args: call.arguments, type: 'tool_call' as const };
      });
      return {
        response: new AIMessage({
          content: '',
          tool_calls: toolCalls,
          response_metadata: { codexThreadId: result.threadId, modelPort: 'codex_exec_json_v1' },
        }),
        usage: toUsage(result.usage),
      };
    } finally {
      await rm(requestDirectory, { recursive: true, force: true });
    }
  }

  private async verifyBinary(): Promise<void> {
    if (!this.binaryVerification) {
      this.binaryVerification = (async () => {
        const actual = await sha256File(this.options.binaryPath);
        if (actual.toLowerCase() !== this.options.expectedBinarySha256.toLowerCase()) {
          throw new CodexModelPortError('readiness', 'codex_binary_hash_mismatch');
        }
        const auth = spawnSync(this.options.binaryPath, ['login', 'status'], {
          cwd: this.options.workRoot, encoding: 'utf8', timeout: CODEX_AUTH_TIMEOUT_MS,
          env: safeCodexEnvironment(this.options.workRoot), stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (auth.error || auth.status !== 0 || !`${auth.stdout}\n${auth.stderr}`.includes('Logged in using ChatGPT')) {
          throw new CodexModelPortError('readiness', 'codex_chatgpt_authentication_unavailable');
        }
      })();
    }
    await this.binaryVerification;
  }

  private async createRequestDirectory(): Promise<string> {
    await mkdir(this.options.workRoot, { recursive: true });
    return mkdtemp(join(this.options.workRoot, 'codex-model-port-'));
  }

  private async executeCodex(
    model: string,
    schemaPath: string,
    requestDirectory: string,
    prompt: string,
    signal?: AbortSignal,
  ) {
    const args = [
      'exec',
      '--model', model,
      '-c', `model_reasoning_effort="${this.options.reasoningEffort}"`,
      '--json',
      '--sandbox', 'read-only',
      '--ignore-user-config',
      '--ephemeral',
      '--skip-git-repo-check',
      '--enable', 'skip_host_skill_discovery',
      ...DISABLED_CODEX_FEATURES.flatMap((feature) => ['--disable', feature]),
      '--cd', requestDirectory,
      '-c', 'project_doc_max_bytes=0',
      '-c', 'web_search="disabled"',
      '--output-schema', schemaPath,
      '-',
    ];
    const maxOutputBytes = this.options.maxOutputBytes ?? 4 * 1024 * 1024;

    return new Promise<ReturnType<CodexExecEventAccumulator['result']>>((resolvePromise, reject) => {
      const child = spawn(this.options.binaryPath, args, {
      cwd: requestDirectory,
        env: safeCodexEnvironment(requestDirectory),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const events = new CodexExecEventAccumulator();
      let stdoutBuffer = '';
      let outputBytes = 0;
      let failure: Error | null = null;
      let forceStop: ReturnType<typeof setTimeout> | null = null;
      let childClosed = false;
      const failurePriority = (error: Error): number => error instanceof CodexModelPortError
        ? error.kind === 'integrity' ? 3 : error.kind === 'readiness' ? 2 : 1
        : 1;
      const recordFailure = (reason: Error) => {
        if (!failure || failurePriority(reason) > failurePriority(failure)) failure = reason;
      };
      const stop = (reason: Error) => {
        recordFailure(reason);
        if (childClosed) return;
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        if (!forceStop) forceStop = setTimeout(() => {
          if (!childClosed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 2_000);
      };
      const timeout = setTimeout(() => {
        stop(new CodexModelPortError('operational', 'codex_request_timed_out'));
      }, this.options.timeoutMs);

      const onAbort = () => {
        stop(new CodexModelPortError('operational', 'codex_request_cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.stdin.once('error', () => {
        stop(new CodexModelPortError('operational', 'codex_prompt_write_failed'));
      });
      child.stderr.on('data', () => undefined);

      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          stop(new CodexModelPortError('operational', 'codex_output_limit'));
          return;
        }
        stdoutBuffer += chunk.toString('utf8');
        let newline = stdoutBuffer.indexOf('\n');
        while (newline >= 0) {
          const line = stdoutBuffer.slice(0, newline);
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          try {
            events.accept(line);
          } catch (error) {
            stop(new CodexModelPortError('integrity', error instanceof Error ? error.message : 'codex_event_invalid'));
            return;
          }
          newline = stdoutBuffer.indexOf('\n');
        }
      });

      child.once('error', () => {
        recordFailure(new CodexModelPortError('readiness', 'codex_process_unavailable'));
      });
      child.once('close', (code) => {
        childClosed = true;
        clearTimeout(timeout);
        if (forceStop) clearTimeout(forceStop);
        signal?.removeEventListener('abort', onAbort);
        try {
          if (stdoutBuffer.trim()) events.accept(stdoutBuffer);
        } catch (error) {
          recordFailure(new CodexModelPortError('integrity', error instanceof Error ? error.message : 'codex_event_tail_invalid'));
        }
        if (failure) {
          reject(failure);
          return;
        }
        if (code !== 0) {
          reject(new CodexModelPortError('operational', 'codex_process_nonzero_exit'));
          return;
        }
        try {
          resolvePromise(events.result());
        } catch (error) {
          reject(new CodexModelPortError('integrity', error instanceof Error ? error.message : 'codex_response_incomplete'));
        }
      });

      child.stdin.end(prompt);
    });
  }
}
