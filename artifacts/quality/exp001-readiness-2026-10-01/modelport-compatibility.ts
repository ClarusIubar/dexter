import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { HumanMessage } from '@langchain/core/messages';
import { CodexExecModelPort, CodexModelPortError } from '../../../src/model/codex-exec-model-port.ts';
import { CodexExecEventAccumulator } from '../../../src/agent/codex-exec-protocol.ts';

const capturedEvents: Record<string, unknown>[] = [];
const originalAccept = CodexExecEventAccumulator.prototype.accept;
CodexExecEventAccumulator.prototype.accept = function (line: string): void {
  for (const eventLine of line.split('\n').filter((value) => value.trim())) {
    if (capturedEvents.length >= 100) break;
    try {
      const event = JSON.parse(eventLine);
      capturedEvents.push({
        type: event.type,
        eventKeys: Object.keys(event),
        itemType: event.item?.type ?? null,
        itemKeys: event.item && typeof event.item === 'object' ? Object.keys(event.item) : null,
        itemStatus: event.item?.status ?? null,
        textLength: typeof event.item?.text === 'string' ? event.item.text.length : null,
        message: typeof event.message === 'string' ? event.message.slice(0, 500) : null,
        itemMessage: typeof event.item?.message === 'string' ? event.item.message.slice(0, 500) : null,
        errorMessage: typeof event.error?.message === 'string' ? event.error.message.slice(0, 500) : null,
      });
    } catch {
      capturedEvents.push({ malformed: true, length: eventLine.length });
    }
  }
  originalAccept.call(this, line);
};

const startedAt = new Date().toISOString();
const report: Record<string, unknown> = {
  checkedDateKst: '2026-10-01',
  evidenceId: 'EXP-001-1872-modelport-compatibility-2026-10-01',
  sourceCommit: '102a446ce5caac3f3860e5d0cb7d3d012277ef57',
  binaryPath: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  binarySha256: '50ac633af64851511f9bbc71032cdae7f1ba20b3234c189687d61ba846c354c5',
  model: 'gpt-6-sol',
  reasoningEffort: 'medium',
  startedAt,
  scope: 'Synthetic tool-free readiness request; not an A/B/AB trial or pilot observation',
  environment: 'macOS approved host execution',
  diagnosticTimeoutMs: 60_000,
  tools: [],
};
const port = new CodexExecModelPort({
  binaryPath: report.binaryPath as string,
  expectedBinarySha256: report.binarySha256 as string,
  workRoot: import.meta.dir,
  timeoutMs: 60_000,
  reasoningEffort: 'medium',
});
try {
  const result = await port.invoke({
    messages: [new HumanMessage('This is a synthetic compatibility check. Return EXP001_READY as the final answer content.')],
    tools: [],
    model: 'gpt-6-sol',
  });
  report.status = 'completed';
  report.exactExpectedContent = result.response.content === 'EXP001_READY';
  report.responseSha256 = createHash('sha256').update(JSON.stringify(result.response.content)).digest('hex');
  report.usage = result.usage ?? null;
  report.usageStatus = result.usage ? 'observed' : 'unavailable';
  process.exitCode = report.exactExpectedContent && result.usage ? 0 : 1;
} catch (error) {
  report.status = 'failed';
  report.failureKind = error instanceof CodexModelPortError ? error.kind : 'unknown';
  report.failureMessage = error instanceof Error ? error.message : 'unknown_failure';
  report.usageStatus = 'unavailable';
  report.usage = null;
  process.exitCode = 1;
}
report.finishedAt = new Date().toISOString();
report.diagnosticAttempt = 3;
report.events = capturedEvents;
report.capturePolicy = 'Structural event metadata only; delegate production validation unchanged';
report.elapsedMs = Date.parse(report.finishedAt as string) - Date.parse(startedAt);
report.nonConclusions = ['No pilot registration or market data', 'No efficacy or architecture winner', 'No Linux readiness proof'];
await writeFile(new URL('./modelport-compatibility.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
