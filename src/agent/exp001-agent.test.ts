import { strict as assert } from 'node:assert';
import { test } from 'bun:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { Agent } from './agent.js';
import type { AgentModelPort } from './types.js';

const INPUT_TOOL = 'exp001.read_trial_input';

test('Original Agent preserves the complete 500-candidate input through its real tool loop', async () => {
  const input = {
    schemaVersion: 'exp001_input_v2',
    trialId: 'full-input-preservation',
    asOf: '2026-09-22T13:00:00.000Z',
    candidates: Array.from({ length: 500 }, (_, index) => ({
      ticker: `T${String(index).padStart(4, '0')}`,
      sector: `S${index % 10}`,
      asOf: '2026-09-21',
      features: { price: 100 + index / 10, ret20: index / 10_000, breakoutRatio: -0.02,
        vol20: 0.2 + index / 100_000, volume: 10_000 + index },
    })),
  };
  const inputJson = JSON.stringify(input);
  assert.ok(inputJson.length > 50_000);
  assert.ok(inputJson.length <= 180_000);
  const tool = new DynamicStructuredTool({
    name: INPUT_TOOL,
    description: 'Return the immutable EXP-001 input fixture.',
    schema: z.object({ trialId: z.string(), inputHash: z.string() }),
    func: async () => inputJson,
  });
  let modelCalls = 0;
  const modelPort: AgentModelPort = {
    async invoke({ messages }) {
      modelCalls += 1;
      if (modelCalls === 1) {
        return { response: new AIMessage({ content: '', tool_calls: [{
          name: INPUT_TOOL, args: { trialId: input.trialId, inputHash: 'a'.repeat(64) }, id: 'read-input-1', type: 'tool_call',
        }] }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      }
      const delivered = messages.find((message) => message instanceof ToolMessage && message.name === INPUT_TOOL);
      assert.ok(delivered instanceof ToolMessage);
      assert.equal(delivered.content, inputJson);
      return { response: new AIMessage({ content: 'complete ranking' }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
  };
  const agent = await Agent.create({ model: 'gpt-6-sol', channel: 'gateway', maxIterations: 2,
    memoryEnabled: false, systemPromptOverride: 'Test-only agent prompt.',
    toolAllowlist: [INPUT_TOOL], additionalTools: [tool], trustedToolNames: [INPUT_TOOL],
    untruncatedToolResults: [INPUT_TOOL], modelPort });
  const events = [];
  for await (const event of agent.run('Read the frozen trial input and return the final ranking.')) events.push(event);
  assert.equal(modelCalls, 2);
  assert.equal(events.find((event) => event.type === 'done')?.answer, 'complete ranking');
});
