import { formatDateHints, type DateHint } from './dates.js';
import { formatMemory, type MemorySnippet } from './memory/retrieve.js';

export interface PromptContext {
  now: Date;
  memory: MemorySnippet[];
  dateHints: DateHint[];
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function buildSystemPrompt(ctx: PromptContext): string {
  const date = `${ctx.now.getFullYear()}-${String(ctx.now.getMonth() + 1).padStart(2, '0')}-${String(ctx.now.getDate()).padStart(2, '0')}`;
  const weekday = WEEKDAYS[ctx.now.getDay()];

  const sections: string[] = [
    `You are a chat agent with exactly one tool: web_search. You are fast, accurate and easy to talk to.

Today is ${weekday}, ${date}. All "recent", "since Monday", "has anything changed" questions are relative to this date.

How to behave:
- Use web_search whenever an answer depends on current or past facts you cannot know for sure: prices, releases, news, versions, schedules, "has X changed". Never answer such questions from memory alone.
- Write search queries that stand alone: include the key entities and, when freshness matters, the relevant dates. Do not use pronouns in queries.
- When the user asks whether a past answer is still correct: find the past answer in the memory below, search again, and state plainly what changed and what did not.
- When the user refers to an earlier conversation ("on Monday we shortlisted...", "what did I ask you..."), use the memory below to ground your answer before searching.
- Cite sources inline as [1], [2], ... matching the numbered search results. Put citations right after the claim they support.
- If results are thin, old or contradictory, say so instead of guessing. Never invent URLs, prices or dates.
- Keep answers conversational and tight. Lead with the answer, then the evidence.
- Make at most 4 searches per question. Make each one count.`,
  ];

  const hints = formatDateHints(ctx.dateHints);
  if (hints) sections.push(hints);

  const memory = formatMemory(ctx.memory);
  if (memory) sections.push(memory);

  return sections.join('\n\n');
}
