/**
 * The agent loop: context assembly -> model -> (tool calls -> model)* -> answer.
 *
 * One turn:
 *   1. Resolve relative dates in the user's message (deterministic, see dates.ts).
 *   2. Retrieve relevant past conversations from memory and inject them.
 *   3. Run the model with the single web_search tool until it produces a final
 *      answer (max 6 model steps, parallel searches per step).
 *   4. Persist the exchange to memory and stream the answer to the caller.
 */
import { resolveDateHints } from './dates.js';
import type { ChatMessage, LlmClient } from './llm.js';
import type { MemoryStore } from './memory/store.js';
import { retrieveMemory } from './memory/retrieve.js';
import { buildSystemPrompt } from './prompt.js';
import type { Recency, SearchOutcome, SearchResult } from './search/index.js';

export const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the public web. Returns ranked results with title, URL, snippet and ' +
      'publication date when known. Use it for anything current, and to re-verify ' +
      'whether a past answer is still true today.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'A self-contained search query with the key entities and, when freshness ' +
            'matters, explicit dates. No pronouns.',
        },
        recency: {
          type: 'string',
          enum: ['any', 'day', 'week', 'month'],
          description:
            'Restrict to recently published pages. Use "week" or "month" for ' +
            '"has anything changed" questions; "any" otherwise.',
        },
      },
      required: ['query'],
    },
  },
};

export type SearchFn = (
  query: string,
  opts: { recency?: Recency; maxResults?: number },
) => Promise<SearchOutcome>;

export interface TurnParams {
  userText: string;
  /** Current-session history (previous turns only; mutated by this call). */
  history: ChatMessage[];
  store: MemoryStore;
  sessionId: string;
  llm: LlmClient;
  search: SearchFn;
  onToken?: (token: string) => void;
  now?: Date;
}

export interface TurnResult {
  answer: string;
  sources: SearchResult[];
  searchProvider?: string;
}

const MAX_STEPS = 6;

function formatToolResults(results: SearchResult[], offset: number): string {
  if (results.length === 0) return 'No results.';
  return results
    .map((r, i) => {
      const n = offset + i + 1;
      const when = r.published ? `, published ${r.published.slice(0, 10)}` : '';
      const host = (() => { try { return new URL(r.url).hostname; } catch { return r.url; } })();
      return `[${n}] ${r.title} (${host}${when})\n${r.url}\n${r.snippet}`;
    })
    .join('\n\n');
}

export async function runTurn(params: TurnParams): Promise<TurnResult> {
  const now = params.now ?? new Date();
  const dateHints = resolveDateHints(params.userText, now);

  // Memory retrieval excludes the live session - that history is already in context.
  const pastTurns = params.store.allTurns().filter((t) => t.sessionId !== params.sessionId);
  const memory = retrieveMemory(pastTurns, params.userText, {
    hintDays: dateHints.map((h) => h.iso),
    now,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt({ now, memory, dateHints }) },
    ...params.history,
    { role: 'user', content: params.userText },
  ];

  const sources: SearchResult[] = [];
  const queryUseCount = new Map<string, number>();
  let searchProvider: string | undefined;
  let answer = '';

  for (let step = 0; step < MAX_STEPS; step++) {
    const isLastStep = step === MAX_STEPS - 1;
    const result = await params.llm.chat({
      messages,
      tools: isLastStep ? undefined : [WEB_SEARCH_TOOL], // force a final answer on the last step
      onToken: params.onToken,
    });

    if (result.toolCalls.length === 0) {
      answer = result.content;
      break;
    }

    messages.push({
      role: 'assistant',
      content: result.content,
      tool_calls: result.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    // Run this step's searches in parallel.
    const searches = result.toolCalls.map(async (tc) => {
      if (tc.name !== 'web_search') {
        return { tc, body: `Unknown tool "${tc.name}". The only tool is web_search.` };
      }
      let args: { query?: string; recency?: Recency };
      try {
        args = JSON.parse(tc.arguments || '{}');
      } catch {
        return { tc, body: 'Invalid tool arguments: not JSON.' };
      }
      const query = (args.query ?? '').trim();
      if (!query) return { tc, body: 'Invalid tool arguments: "query" is required.' };

      const normalized = query.toLowerCase();
      const uses = (queryUseCount.get(normalized) ?? 0) + 1;
      queryUseCount.set(normalized, uses);
      if (uses > 2) {
        return { tc, body: 'You already ran this exact search twice. Answer with what you have.' };
      }

      try {
        const outcome = await params.search(query, { recency: args.recency });
        searchProvider = outcome.provider;
        const offset = sources.length;
        sources.push(...outcome.results);
        return { tc, body: formatToolResults(outcome.results, offset) };
      } catch (err) {
        return { tc, body: `Search failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    });

    for (const { tc, body } of await Promise.all(searches)) {
      messages.push({ role: 'tool', tool_call_id: tc.id, content: body });
    }
  }

  if (!answer) answer = 'I ran out of search steps before I could answer. Please try again.';

  // Persist the exchange so future sessions can recall it.
  params.store.addTurn(params.sessionId, 'user', params.userText, now);
  params.store.addTurn(params.sessionId, 'assistant', answer, now);
  params.history.push(
    { role: 'user', content: params.userText },
    { role: 'assistant', content: answer },
  );

  return { answer, sources, searchProvider };
}
