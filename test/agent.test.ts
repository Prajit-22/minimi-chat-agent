import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurn, WEB_SEARCH_TOOL, type SearchFn } from '../src/agent.js';
import type { ChatParams, ChatResult, LlmClient } from '../src/llm.js';
import { MemoryStore } from '../src/memory/store.js';

/** A scripted model: returns queued responses, records every call. */
class FakeLlm implements LlmClient {
  calls: ChatParams[] = [];
  constructor(private script: ChatResult[]) {}
  async chat(params: ChatParams): Promise<ChatResult> {
    this.calls.push(params);
    const next = this.script.shift();
    if (!next) return { content: 'final', toolCalls: [] };
    if (next.content && params.onToken) params.onToken(next.content);
    return next;
  }
}

const fakeSearchResults = [
  { title: 'HubSpot Pricing', url: 'https://www.hubspot.com/pricing', snippet: 'Plans from $20.', published: '2026-11-08' },
  { title: 'Pipedrive Pricing', url: 'https://www.pipedrive.com/pricing', snippet: 'Plans from $14.', published: '2026-11-07' },
];

function makeSearch(calls: string[]): SearchFn {
  return async (query) => {
    calls.push(query);
    return { provider: 'fake', results: fakeSearchResults };
  };
}

const NOW = new Date(2026, 10, 10, 12, 0, 0); // Tuesday 2026-11-10

test('a full turn: search, numbered tool results, streamed answer, memory write', async () => {
  const store = new MemoryStore(':memory:');
  const sessionId = store.createSession();
  const llm = new FakeLlm([
    { content: '', toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{"query":"CRM pricing November 2026","recency":"month"}' }] },
    { content: 'HubSpot still starts at $20 [1]; Pipedrive is unchanged [2].', toolCalls: [] },
  ]);
  const searchCalls: string[] = [];
  const history: any[] = [];
  const streamed: string[] = [];

  const result = await runTurn({
    userText: 'Last Tuesday we shortlisted CRM tools. Any pricing changes?',
    history, store, sessionId, llm, search: makeSearch(searchCalls),
    onToken: (t) => streamed.push(t), now: NOW,
  });

  assert.deepEqual(searchCalls, ['CRM pricing November 2026']);
  assert.match(result.answer, /HubSpot still starts at \$20/);
  assert.equal(result.sources.length, 2);
  assert.equal(streamed.join(''), result.answer);

  // The model saw numbered, dated results in the tool message.
  const toolMsg = llm.calls[1]!.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg!.content, /\[1\] HubSpot Pricing \(www\.hubspot\.com, published 2026-11-08\)/);
  assert.match(toolMsg!.content, /\[2\] Pipedrive Pricing/);

  // The system prompt carried today's date and the resolved "last Tuesday".
  const system = llm.calls[0]!.messages[0]!;
  assert.match(system.content, /Today is Tuesday, 2026-11-10/);
  assert.match(system.content, /"Last Tuesday" = Tuesday, 2026-11-03/);

  // The exchange was persisted to memory and session history advanced.
  assert.equal(store.allTurns().length, 2);
  assert.equal(history.length, 2);
  store.close();
});

test('memory from a previous session is injected into the next one', async () => {
  const store = new MemoryStore(':memory:');
  const s1 = store.createSession();
  store.addTurn(s1, 'user', 'What is the best Postgres hosting?', new Date(2026, 10, 3, 9));
  store.addTurn(s1, 'assistant', 'Neon was cheapest at your scale [1].', new Date(2026, 10, 3, 9));

  const s2 = store.createSession();
  const llm = new FakeLlm([{ content: 'On 2026-11-03 you asked about Postgres hosting.', toolCalls: [] }]);
  const result = await runTurn({
    userText: 'What did I ask you on 3 November?',
    history: [], store, sessionId: s2, llm, search: makeSearch([]), now: NOW,
  });
  const system = llm.calls[0]!.messages[0]!;
  assert.match(system.content, /best Postgres hosting/);
  assert.match(system.content, /\[memory 1\] 2026-11-03/);
  assert.match(result.answer, /Postgres hosting/);
  store.close();
});

test('the same query is never run a third time', async () => {
  const store = new MemoryStore(':memory:');
  const sessionId = store.createSession();
  const repeat = { content: '', toolCalls: [{ id: 'c', name: 'web_search', arguments: '{"query":"same query"}' }] };
  const llm = new FakeLlm([
    structuredClone(repeat), structuredClone(repeat), structuredClone(repeat),
    { content: 'done', toolCalls: [] },
  ]);
  const searchCalls: string[] = [];
  await runTurn({
    userText: 'q', history: [], store, sessionId, llm, search: makeSearch(searchCalls), now: NOW,
  });
  assert.equal(searchCalls.length, 2);
  const lastTool = llm.calls[3]!.messages.filter((m) => m.role === 'tool').at(-1)!;
  assert.match(lastTool.content, /already ran this exact search twice/);
  store.close();
});

test('the last step drops tools so the model must answer', async () => {
  const store = new MemoryStore(':memory:');
  const sessionId = store.createSession();
  const alwaysSearch: ChatResult = { content: '', toolCalls: [{ id: 'c', name: 'web_search', arguments: '{"query":"x"}' }] };
  const script = Array.from({ length: 6 }, (_, i) => ({
    ...structuredClone(alwaysSearch),
    toolCalls: [{ id: `c${i}`, name: 'web_search', arguments: `{"query":"x${i}"}` }],
  }));
  const llm = new FakeLlm(script);
  const searchCalls: string[] = [];
  const result = await runTurn({
    userText: 'q', history: [], store, sessionId, llm, search: makeSearch(searchCalls), now: NOW,
  });
  assert.equal(llm.calls.length, 6);
  assert.equal(llm.calls[5]!.tools, undefined); // final step: no tools offered
  assert.match(result.answer, /ran out of search steps|final/);
  store.close();
});

test('the advertised tool schema has exactly one tool with a required query', () => {
  assert.equal(WEB_SEARCH_TOOL.function.name, 'web_search');
  assert.deepEqual(WEB_SEARCH_TOOL.function.parameters.required, ['query']);
});
