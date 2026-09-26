import { PassThrough } from 'node:stream';
import { expect, test } from 'bun:test';
import { JsonLineReader } from './exp001-bridge.ts';

test('rejects every pending IPC read as soon as the input stream closes', async () => {
  const input = new PassThrough();
  const reader = new JsonLineReader(input);
  const pending = [reader.next(), reader.next()];
  input.end();
  const results = await Promise.allSettled(pending);
  expect(results).toHaveLength(2);
  expect(results.every((result) => result.status === 'rejected'
    && result.reason instanceof Error && result.reason.message === 'wire_stdin_closed')).toBe(true);
});
