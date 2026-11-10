import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSseStream, OpenAICompatibleClient } from '../src/llm.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

test('streams content deltas to the token callback', async () => {
  const chunks = [
    `data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":", world"}}]}\n\n`,
    `data: [DONE]\n\n`,
  ];
  const seen: string[] = [];
  const result = await readSseStream(streamOf(chunks), (t) => seen.push(t));
  assert.equal(result.content, 'Hello, world');
  assert.deepEqual(seen, ['Hello', ', world']);
  assert.equal(result.toolCalls.length, 0);
});

test('accumulates tool calls fragmented across chunks', async () => {
  const chunks = [
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"web_` + `"}}]}}]}\n\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"search","arguments":"{\\"que` + `"}}]}}]}\n\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ry\\":\\"hubspot pricing\\"}"}}]}}]}\n\ndata: [DONE]\n\n`,
  ];
  const result = await readSseStream(streamOf(chunks));
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]!.id, 'call_1');
  assert.equal(result.toolCalls[0]!.name, 'web_search');
  assert.deepEqual(JSON.parse(result.toolCalls[0]!.arguments), { query: 'hubspot pricing' });
});

test('HTTP errors surface the status and body', async () => {
  const fetchImpl = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
  const client = new OpenAICompatibleClient({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' }, fetchImpl);
  await assert.rejects(() => client.chat({ messages: [] }), /HTTP 429 rate limited/);
});
