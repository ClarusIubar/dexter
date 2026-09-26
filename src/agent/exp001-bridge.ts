import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { Agent } from './agent.js';
import type { AgentModelPort, AgentEvent } from './types.js';
import { CodexExecModelPort, CodexModelPortError } from '../model/codex-exec-model-port.js';
import { parseJsonWithoutDuplicateKeys } from './unique-json.js';
import { classifyExp001BridgeFailure, classifyExp001BridgeToolFailure } from './exp001-bridge-failure.js';

const WIRE_VERSION = 'exp001_shared_wire_v3';
const READ_INPUT_TOOL = 'exp001.read_trial_input';
const CORE_TOOL = 'dexter_core.evaluate';
const MAX_FROZEN_INPUT_CHARS = 180_000;
interface FrozenInput extends Record<string, unknown> {
  readonly schemaVersion: 'exp001_input_v2';
  readonly trialId: string;
  readonly asOf: string;
  readonly candidates: readonly { readonly ticker: string; readonly sector: string }[];
}
const SCHEMA_PATH = new URL('./exp001-shared-wire-v3.schema.json', import.meta.url);
const READ_INPUT_SCHEMA = z.object({ trialId: z.string(), inputHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const CORE_SCHEMA = z.object({ trialId: z.string(), inputHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

interface StartMessage extends Record<string, unknown> {
  readonly type: 'start';
  readonly schemaVersion: typeof WIRE_VERSION;
  readonly wireSchemaSha256: string;
  readonly runId: string;
  readonly trialId: string;
  readonly arm: 'A' | 'AB';
  readonly inputHash: string;
  readonly input: FrozenInput;
  readonly policyHash: string;
  readonly model: string;
  readonly reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  readonly systemPrompt: string;
  readonly query: string;
  readonly deadlineAt: string;
  readonly maxIterations: 2;
  readonly codexBinaryPath: string;
  readonly codexBinarySha256: string;
  readonly codexWorkRoot: string;
  readonly agentSourceBaseCommit: string;
  readonly agentSourcePatchSha256: string;
}

interface CoreResponse extends Record<string, unknown> {
  readonly type: 'core_response';
  readonly schemaVersion: typeof WIRE_VERSION;
  readonly wireSchemaSha256: string;
  readonly runId: string;
  readonly requestId: string;
  readonly trialId: string;
  readonly inputHash: string;
  readonly decision: Record<string, unknown>;
}

interface ModelCallTelemetry extends Record<string, unknown> {
  readonly ordinal: number;
  readonly requestSha256: string;
  readonly inputSnapshotIncluded: boolean;
  readonly inputSnapshotSha256: string | null;
  readonly coreResultIncluded: boolean;
  readonly coreResultSha256: string | null;
  readonly status: 'completed' | 'failed';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly usageStatus: 'observed' | 'unavailable';
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly failureKind: CodexModelPortError['kind'] | null;
}

interface CoreRpcTelemetry extends Record<string, unknown> {
  readonly status: 'completed' | 'failed';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
}

interface BridgeTelemetry {
  coreRpc: CoreRpcTelemetry | null;
  coreDecisionHash: string | null;
  coreToolCallCount: number;
  readonly toolNames: string[];
}

export class JsonLineReader {
  private readonly lines: string[] = [];
  private readonly waiters: { resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
  private ended = false;

  constructor(stream: NodeJS.ReadableStream) {
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    reader.on('line', (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.lines.push(line);
    });
    reader.on('close', () => {
      this.ended = true;
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('wire_stdin_closed'));
    });
  }

  async next(): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) return line;
    if (this.ended) throw new Error('wire_stdin_closed');
    return await new Promise<string>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('wire_nonfinite_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!isRecord(value)) throw new Error('wire_non_plain_object');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function exp001SchemaSha256(): string {
  return sha256(readFileSync(SCHEMA_PATH));
}

function sourceIdentity(): { baseCommit: string; patchSha256: string } {
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw new Error('source_base_commit_invalid');
  const names = new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'package.json', 'bun.lock', 'bun.lockb'], { encoding: 'utf8' })
    .split('\n').filter(Boolean));
  for (const name of execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'src', 'package.json', 'bun.lock', 'bun.lockb'], { encoding: 'utf8' })
    .split('\n').filter(Boolean)) names.add(name);
  const digest = createHash('sha256');
  for (const name of [...names].sort()) {
    digest.update(name, 'utf8').update(Buffer.from([0]));
    if (existsSync(name)) digest.update(readFileSync(name)).update(Buffer.from([0]));
    else digest.update('<deleted>', 'utf8').update(Buffer.from([0]));
  }
  return { baseCommit, patchSha256: digest.digest('hex') };
}

function assertInput(input: Record<string, unknown>, trialId: string, expectedHash: string): void {
  const cutoff = typeof input.asOf === 'string' ? Date.parse(input.asOf) : Number.NaN;
  const normalizedCutoff = typeof input.asOf === 'string' && input.asOf.endsWith('Z')
    ? input.asOf.replace(/(?<=:\d{2})Z$/, '.000Z') : input.asOf;
  if (Object.keys(input).length !== 4 || input.schemaVersion !== 'exp001_input_v2'
    || input.trialId !== trialId || typeof input.asOf !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.asOf)
    || !Number.isFinite(cutoff) || new Date(cutoff).toISOString() !== normalizedCutoff
    || !Array.isArray(input.candidates) || input.candidates.length === 0
    || canonical(input).length > MAX_FROZEN_INPUT_CHARS
    || sha256(canonical(input)) !== expectedHash) throw new Error('input_contract_invalid');
  let previous = '';
  for (const item of input.candidates) {
    const candidateValue = isRecord(item) ? item.asOf : undefined;
    const candidateAsOf = typeof candidateValue === 'string' ? candidateValue : '';
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(candidateAsOf);
    const candidateCutoff = dateOnly
      ? Date.parse(`${candidateAsOf}T00:00:00.000Z`)
      : Date.parse(candidateAsOf);
    const normalizedCandidateAsOf = dateOnly ? `${candidateAsOf}T00:00:00.000Z`
      : candidateAsOf.endsWith('Z') && /(?<=:\d{2})Z$/.test(candidateAsOf)
        ? candidateAsOf.replace(/(?<=:\d{2})Z$/, '.000Z') : candidateAsOf;
    if (!isRecord(item) || Object.keys(item).length !== 4 || typeof item.ticker !== 'string'
      || !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(item.ticker) || item.ticker <= previous
      || typeof item.sector !== 'string' || !item.sector.trim() || typeof item.asOf !== 'string'
      || !(dateOnly || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(candidateAsOf))
      || !Number.isFinite(candidateCutoff)
      || new Date(candidateCutoff).toISOString() !== normalizedCandidateAsOf
      || candidateCutoff > cutoff
      || !isRecord(item.features) || Object.keys(item.features).length !== 5) throw new Error('input_candidate_invalid');
    previous = item.ticker;
    for (const key of ['price', 'ret20', 'breakoutRatio', 'vol20']) {
      if (typeof item.features[key] !== 'number' || !Number.isFinite(item.features[key])) throw new Error('input_feature_invalid');
    }
    if ((item.features.price as number) <= 0 || (item.features.breakoutRatio as number) <= -1
      || (item.features.ret20 as number) <= -1 || (item.features.vol20 as number) < 0) {
      throw new Error('input_feature_range_invalid');
    }
    if (item.features.volume !== null && (typeof item.features.volume !== 'number'
      || !Number.isFinite(item.features.volume) || item.features.volume < 0)) throw new Error('input_volume_invalid');
  }
}

function assertStart(value: unknown): asserts value is StartMessage {
  if (!isRecord(value)) throw new Error('wire_start_invalid');
  const expectedKeys = ['type', 'schemaVersion', 'wireSchemaSha256', 'runId', 'trialId', 'arm', 'inputHash', 'input',
    'policyHash', 'model', 'reasoningEffort', 'systemPrompt', 'query', 'deadlineAt', 'maxIterations',
    'codexBinaryPath', 'codexBinarySha256', 'codexWorkRoot', 'agentSourceBaseCommit', 'agentSourcePatchSha256'];
  if (Object.keys(value).length !== expectedKeys.length || Object.keys(value).some((key) => !expectedKeys.includes(key))
    || value.type !== 'start' || value.schemaVersion !== WIRE_VERSION || value.wireSchemaSha256 !== exp001SchemaSha256()
    || typeof value.runId !== 'string' || !value.runId.trim()
    || typeof value.trialId !== 'string' || !value.trialId.trim()
    || (value.arm !== 'A' && value.arm !== 'AB')
    || typeof value.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputHash)
    || !isRecord(value.input) || typeof value.policyHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.policyHash)
    || typeof value.model !== 'string' || !value.model.trim()
    || !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.reasoningEffort as string)
    || typeof value.systemPrompt !== 'string' || !value.systemPrompt.trim()
    || typeof value.query !== 'string' || !value.query.trim()
    || typeof value.deadlineAt !== 'string' || !Number.isFinite(Date.parse(value.deadlineAt))
    || value.maxIterations !== 2
    || typeof value.codexBinaryPath !== 'string' || !value.codexBinaryPath.startsWith('/')
    || typeof value.codexBinarySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.codexBinarySha256)
    || typeof value.codexWorkRoot !== 'string' || !value.codexWorkRoot.startsWith('/Volumes/PortableSSD/')
    || typeof value.agentSourceBaseCommit !== 'string' || !/^[a-f0-9]{40}$/.test(value.agentSourceBaseCommit)
    || typeof value.agentSourcePatchSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.agentSourcePatchSha256)) {
    throw new Error('wire_start_invalid');
  }
  assertInput(value.input, value.trialId, value.inputHash);
  const identity = sourceIdentity();
  if (identity.baseCommit !== value.agentSourceBaseCommit || identity.patchSha256 !== value.agentSourcePatchSha256) {
    throw new Error('agent_source_identity_mismatch');
  }
}

function sendWireMessage(value: Record<string, unknown>): void {
  const payload = `${JSON.stringify(value)}\n`;
  writeSync(3, payload);
}

function parseJsonLine(line: string): unknown {
  try { return parseJsonWithoutDuplicateKeys(line); } catch { throw new Error('wire_json_invalid'); }
}

function assertCoreDecision(value: Record<string, unknown>, start: StartMessage): void {
  const decisionKeys = ['schemaVersion', 'trialId', 'arm', 'status', 'inputHash', 'policyHash',
    'orderedTickers', 'selectedTickers', 'reason', 'dependencyHashes', 'decisionHash'];
  if (Object.keys(value).length !== decisionKeys.length || Object.keys(value).some((key) => !decisionKeys.includes(key))
    || value.schemaVersion !== 'exp001_arm_decision_v2' || value.trialId !== start.trialId || value.arm !== 'B'
    || value.inputHash !== start.inputHash || typeof value.policyHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.policyHash)
    || typeof value.decisionHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.decisionHash)
    || !Array.isArray(value.orderedTickers) || value.orderedTickers.some((ticker) => typeof ticker !== 'string')
    || !Array.isArray(value.selectedTickers) || value.selectedTickers.some((ticker) => typeof ticker !== 'string')
    || !Array.isArray(value.dependencyHashes) || value.dependencyHashes.length !== 0) throw new Error('core_decision_invalid');
  const { decisionHash, ...payload } = value;
  if (sha256(canonical(payload)) !== decisionHash) throw new Error('core_decision_hash_invalid');
  if (value.status === 'cash') {
    if (typeof value.reason !== 'string' || !value.reason.trim()
      || value.orderedTickers.length !== 0 || value.selectedTickers.length !== 0) throw new Error('core_decision_cash_invalid');
    return;
  }
  if (value.status !== 'ranked' || value.reason !== null
    || value.orderedTickers.length !== start.input.candidates.length
    || new Set(value.orderedTickers).size !== start.input.candidates.length
    || value.orderedTickers.some((ticker) => !start.input.candidates.some((candidate) => candidate.ticker === ticker))) {
    throw new Error('core_decision_ranking_invalid');
  }
  const sectorByTicker = new Map<string, string>();
  for (const candidate of start.input.candidates) {
    if (!isRecord(candidate) || typeof candidate.ticker !== 'string' || typeof candidate.sector !== 'string') {
      throw new Error('core_decision_input_invalid');
    }
    sectorByTicker.set(candidate.ticker, candidate.sector);
  }
  const sectors = new Map<string, string[]>();
  for (const ticker of value.orderedTickers as string[]) {
    const sector = sectorByTicker.get(ticker)!;
    if (!sectors.has(sector)) sectors.set(sector, []);
    sectors.get(sector)!.push(ticker);
  }
  const expectedSelection = [...sectors.values()].filter((tickers) => tickers.length >= 5)
    .slice(0, 5).flatMap((tickers) => tickers.slice(0, 5));
  if (expectedSelection.length !== 25 || canonical(expectedSelection) !== canonical(value.selectedTickers)) {
    throw new Error('core_decision_selection_invalid');
  }
}

function assertCoreResponse(value: unknown, start: StartMessage, requestId: string): asserts value is CoreResponse {
  const keys = ['type', 'schemaVersion', 'wireSchemaSha256', 'runId', 'requestId', 'trialId', 'inputHash', 'decision'];
  if (!isRecord(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))
    || value.type !== 'core_response' || value.schemaVersion !== WIRE_VERSION
    || value.wireSchemaSha256 !== start.wireSchemaSha256 || value.runId !== start.runId
    || value.requestId !== requestId || value.trialId !== start.trialId || value.inputHash !== start.inputHash
    || !isRecord(value.decision)) throw new Error('core_response_invalid');
  assertCoreDecision(value.decision, start);
}

function messageDigest(messages: readonly BaseMessage[]): string {
  const semantic = messages.map((message) => {
    const result: Record<string, unknown> = { role: message._getType(), content: message.content };
    if (message.name) result.name = message.name;
    if (message instanceof ToolMessage) result.toolCallId = message.tool_call_id;
    if ('tool_calls' in message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      result.toolCalls = message.tool_calls;
    }
    return result;
  });
  return sha256(canonical(semantic));
}

function inputSnapshotHash(messages: readonly BaseMessage[], start: StartMessage): string | null {
  const matches = messages.filter((message) => message instanceof ToolMessage && message.name === READ_INPUT_TOOL);
  if (matches.length === 0) return null;
  if (matches.length !== 1 || typeof matches[0]!.content !== 'string') throw new Error('input_tool_result_invalid');
  const input = parseJsonLine(matches[0]!.content as string);
  if (!isRecord(input)) throw new Error('input_tool_result_invalid');
  assertInput(input, start.trialId, start.inputHash);
  return sha256(canonical(input));
}

function coreResultHash(messages: readonly BaseMessage[]): string | null {
  const matches = messages.filter((message) => message instanceof ToolMessage && message.name === CORE_TOOL);
  if (matches.length === 0) return null;
  if (matches.length !== 1 || typeof matches[0]!.content !== 'string') throw new Error('core_tool_result_invalid');
  const parsed = parseJsonLine(matches[0]!.content as string);
  if (!isRecord(parsed) || typeof parsed.decisionHash !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.decisionHash)) {
    throw new Error('core_tool_result_invalid');
  }
  return parsed.decisionHash;
}

async function runBridge(start: StartMessage, inputReader: JsonLineReader,
  modelCalls: ModelCallTelemetry[], telemetry: BridgeTelemetry): Promise<Record<string, unknown>> {
  const toolNames = telemetry.toolNames;
  let inputReadCount = 0;
  let coreToolCallCount = telemetry.coreToolCallCount;
  let modelPortFailure: CodexModelPortError['kind'] | null = null;
  const remainingMs = Date.parse(start.deadlineAt) - Date.now();
  if (remainingMs <= 0) throw new Error('deadline_exceeded');
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), remainingMs);
  const onSigterm = () => controller.abort();
  const basePort = new CodexExecModelPort({
    binaryPath: start.codexBinaryPath,
    expectedBinarySha256: start.codexBinarySha256,
    workRoot: start.codexWorkRoot,
    timeoutMs: Math.min(600_000, remainingMs),
    reasoningEffort: start.reasoningEffort,
  });
  const recordingPort: AgentModelPort = {
    async invoke(input) {
      if (modelCalls.length >= start.maxIterations) throw new Error('agent_model_turn_limit');
      const includedCoreHash = coreResultHash(input.messages);
      const includedInputHash = inputSnapshotHash(input.messages, start);
      const ordinal = modelCalls.length + 1;
      const startedAt = new Date().toISOString();
      const startedClock = performance.now();
      const requestSha256 = messageDigest(input.messages);
      const common = { ordinal, requestSha256, inputSnapshotIncluded: includedInputHash !== null,
        inputSnapshotSha256: includedInputHash, coreResultIncluded: includedCoreHash !== null,
        coreResultSha256: includedCoreHash, startedAt };
      let result;
      try { result = await basePort.invoke({ ...input, signal: controller.signal }); }
      catch (error) {
        modelPortFailure = error instanceof CodexModelPortError ? error.kind : 'operational';
        const finishedAt = new Date().toISOString();
        modelCalls.push({ ...common, status: 'failed', finishedAt,
          elapsedMs: Math.max(0, Math.round(performance.now() - startedClock)), usageStatus: 'unavailable',
          inputTokens: null, outputTokens: null, failureKind: modelPortFailure });
        throw error;
      }
      const finishedAt = new Date().toISOString();
      modelCalls.push({ ...common, status: 'completed', finishedAt,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedClock)),
        usageStatus: result.usage ? 'observed' : 'unavailable',
        inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null,
        failureKind: null });
      if (!result.usage) throw new Error('agent_usage_missing');
      return result;
    },
  };

  const readTool = new DynamicStructuredTool({
    name: READ_INPUT_TOOL,
    description: 'Return this trial’s frozen input bundle; it contains decision-time features only.',
    schema: READ_INPUT_SCHEMA,
    func: async (args) => {
      if (args.trialId !== start.trialId || args.inputHash !== start.inputHash || ++inputReadCount !== 1) {
        throw new Error('frozen_input_request_invalid');
      }
      return JSON.stringify(start.input);
    },
  });

  const extraTools: StructuredToolInterface[] = [readTool];
  if (start.arm === 'AB') {
    extraTools.push(new DynamicStructuredTool({
      name: CORE_TOOL,
      description: 'Request the deterministic Dexter Core decision for this exact trial and frozen input.',
      schema: CORE_SCHEMA,
      func: async (args) => {
        if (args.trialId !== start.trialId || args.inputHash !== start.inputHash || coreToolCallCount !== 0) {
          throw new Error('core_tool_request_invalid');
        }
        coreToolCallCount = 1;
        telemetry.coreToolCallCount = coreToolCallCount;
        const requestId = `${start.runId}-core-1`;
        const startedAt = new Date().toISOString();
        const startedClock = performance.now();
        let status: 'completed' | 'failed' = 'failed';
        try {
          sendWireMessage({ type: 'core_request', schemaVersion: WIRE_VERSION,
            wireSchemaSha256: start.wireSchemaSha256, runId: start.runId, requestId,
            trialId: start.trialId, inputHash: start.inputHash });
          const response = parseJsonLine(await inputReader.next());
          assertCoreResponse(response, start, requestId);
          telemetry.coreDecisionHash = response.decision.decisionHash as string;
          status = 'completed';
          return JSON.stringify(response.decision);
        } finally {
          telemetry.coreRpc = { status, startedAt, finishedAt: new Date().toISOString(),
            elapsedMs: Math.max(0, Math.round(performance.now() - startedClock)) };
        }
      },
    }));
  }

  const toolAllowlist = extraTools.map((tool) => tool.name);
  const expectedPolicyHash = sha256(canonical({ variantId: 'original_dexter_agent_core_v2',
    model: start.model, reasoningEffort: start.reasoningEffort, systemPrompt: start.systemPrompt,
    toolAllowlist: [...toolAllowlist].sort(), maxIterations: start.maxIterations,
    modelPort: 'codex_exec_json_v1', memoryEnabled: false }));
  if (start.policyHash !== expectedPolicyHash) throw new Error('agent_policy_hash_mismatch');

  process.once('SIGTERM', onSigterm);
  try {
    const agent = await Agent.create({ model: start.model, channel: 'gateway',
      systemPromptOverride: start.systemPrompt, memoryEnabled: false, maxIterations: start.maxIterations,
      toolAllowlist, additionalTools: extraTools, modelPort: recordingPort,
      trustedToolNames: toolAllowlist, untruncatedToolResults: [READ_INPUT_TOOL], signal: controller.signal });
    let finalAnswer: string | null = null;
    for await (const event of agent.run(start.query)) {
      if (event.type === 'tool_end') toolNames.push(event.tool);
      if (event.type === 'tool_error' || event.type === 'tool_denied') {
        const reason = classifyExp001BridgeToolFailure(event.type, event.tool,
          event.type === 'tool_error' ? event.error : null);
        throw new Error(`exp001_bridge_failure:${reason}`);
      }
      if (event.type === 'done') finalAnswer = event.answer;
    }
    if (modelPortFailure) throw new Error(`model_port_${modelPortFailure}`);
    if (!finalAnswer || finalAnswer.startsWith('Error:') || modelCalls.length !== 2
      || inputReadCount !== 1 || toolNames.filter((name) => name === READ_INPUT_TOOL).length !== 1
      || toolNames.filter((name) => name === CORE_TOOL).length !== (start.arm === 'AB' ? 1 : 0)) {
      throw new Error('agent_run_incomplete');
    }
    const finalValue = parseJsonLine(finalAnswer);
    if (!isRecord(finalValue) || Object.keys(finalValue).length !== 2
      || !Array.isArray(finalValue.preferences)
      || finalValue.coreDecisionHash !== (start.arm === 'AB' ? telemetry.coreDecisionHash : null)) {
      throw new Error('agent_final_response_invalid');
    }
    const tickers = new Set(start.input.candidates.map((candidate) => (candidate as Record<string, unknown>).ticker));
    const seen = new Set<string>();
    for (const item of finalValue.preferences) {
      if (!isRecord(item) || Object.keys(item).length !== 2 || typeof item.ticker !== 'string'
        || !tickers.has(item.ticker) || seen.has(item.ticker) || typeof item.score !== 'number'
        || !Number.isFinite(item.score) || item.score < 0 || item.score > 1) throw new Error('agent_preferences_invalid');
      seen.add(item.ticker);
    }
    if (seen.size !== tickers.size) throw new Error('agent_preferences_incomplete');
    const firstCall = modelCalls[0]!;
    const finalCall = modelCalls[1]!;
    if (firstCall.inputSnapshotIncluded || firstCall.inputSnapshotSha256 !== null
      || finalCall.inputSnapshotIncluded !== true || finalCall.inputSnapshotSha256 !== start.inputHash
      || firstCall.coreResultIncluded || firstCall.coreResultSha256 !== null
      || finalCall.coreResultIncluded !== (start.arm === 'AB')
      || finalCall.coreResultSha256 !== (start.arm === 'AB' ? telemetry.coreDecisionHash : null)) {
      throw new Error('agent_core_result_not_consumed');
    }
    const usage = modelCalls.reduce((total, call) => ({
      inputTokens: total.inputTokens + (call.inputTokens as number),
      outputTokens: total.outputTokens + (call.outputTokens as number),
    }), { inputTokens: 0, outputTokens: 0 });
    const identity = sourceIdentity();
    return {
      type: 'result', schemaVersion: WIRE_VERSION, wireSchemaSha256: start.wireSchemaSha256,
      runId: start.runId, trialId: start.trialId, arm: start.arm, inputHash: start.inputHash,
      policyHash: start.policyHash, preferences: finalValue.preferences,
      coreDecisionHash: start.arm === 'AB' ? telemetry.coreDecisionHash : null, coreToolCallCount,
      coreRpc: telemetry.coreRpc, modelCalls, toolNames,
      sourceBaseCommit: identity.baseCommit, sourcePatchSha256: identity.patchSha256,
      usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens },
    };
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGTERM', onSigterm);
  }
}

async function main(): Promise<void> {
  const reader = new JsonLineReader(process.stdin);
  let runId = 'invalid-request';
  let wireSchemaSha256 = exp001SchemaSha256();
  let validatedStart: StartMessage | null = null;
  const modelCalls: ModelCallTelemetry[] = [];
  const telemetry: BridgeTelemetry = { coreRpc: null, coreDecisionHash: null, coreToolCallCount: 0, toolNames: [] };
  try {
    const start = parseJsonLine(await reader.next());
    if (isRecord(start) && typeof start.runId === 'string') runId = start.runId;
    if (isRecord(start) && typeof start.wireSchemaSha256 === 'string') wireSchemaSha256 = start.wireSchemaSha256;
    assertStart(start);
    validatedStart = start;
    sendWireMessage(await runBridge(start, reader, modelCalls, telemetry));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const reason = classifyExp001BridgeFailure(message);
    sendWireMessage({ type: 'failure', schemaVersion: WIRE_VERSION, wireSchemaSha256, runId, reason,
      sourceBaseCommit: validatedStart?.agentSourceBaseCommit ?? null,
      sourcePatchSha256: validatedStart?.agentSourcePatchSha256 ?? null,
      coreDecisionHash: telemetry.coreDecisionHash, coreToolCallCount: telemetry.coreToolCallCount,
      coreRpc: telemetry.coreRpc, modelCalls, toolNames: telemetry.toolNames });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
