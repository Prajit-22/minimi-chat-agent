/**
 * Lexical (BM25-style) retrieval over past conversations.
 *
 * The challenge allows exactly one tool, and we spend it on web search - so
 * memory is not a tool the model calls. Instead, before every answer we
 * retrieve the most relevant past turns and inject them as context. Lexical
 * scoring keeps this deterministic, instant and free of a second API key
 * (embeddings were considered and rejected; see DESIGN.md).
 */
import type { StoredTurn } from './store.js';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'i', 'you', 'we', 'they', 'he', 'she',
  'it', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'but', 'with', 'about', 'what',
  'did', 'do', 'does', 'have', 'has', 'had', 'any', 'me', 'my', 'your', 'them', 'this',
  'that', 'these', 'those', 'still', 'today', 'ask', 'asked', 'tell', 'told', 'since',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** A past exchange: one user message plus the assistant reply that followed. */
export interface MemorySnippet {
  day: string;
  question: string;
  answer: string;
  score: number;
}

interface Doc {
  snippet: MemorySnippet;
  tokens: Map<string, number>;
  length: number;
}

/** Pair up user/assistant turns into retrievable documents. */
export function buildDocs(turns: StoredTurn[]): Doc[] {
  const docs: Doc[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    if (turn.role !== 'user') continue;
    const reply = turns[i + 1]?.role === 'assistant' ? turns[i + 1]! : undefined;
    const text = turn.content + '\n' + (reply?.content ?? '');
    const tokens = new Map<string, number>();
    for (const t of tokenize(text)) tokens.set(t, (tokens.get(t) ?? 0) + 1);
    docs.push({
      snippet: {
        day: turn.day,
        question: turn.content,
        answer: reply?.content ?? '',
        score: 0,
      },
      tokens,
      length: text.length,
    });
  }
  return docs;
}

export interface RetrieveOptions {
  limit?: number;
  /** Resolved days mentioned in the query (YYYY-MM-DD) get a strong boost. */
  hintDays?: string[];
  now?: Date;
}

export function retrieveMemory(
  turns: StoredTurn[],
  query: string,
  opts: RetrieveOptions = {},
): MemorySnippet[] {
  const limit = opts.limit ?? 4;
  const hintDays = new Set(opts.hintDays ?? []);
  const now = opts.now ?? new Date();
  const docs = buildDocs(turns);
  if (docs.length === 0) return [];

  // Document frequency for idf.
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const t of doc.tokens.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / n || 1;

  const k1 = 1.2;
  const b = 0.75;
  const queryTokens = tokenize(query);

  for (const doc of docs) {
    let score = 0;
    for (const t of queryTokens) {
      const tf = doc.tokens.get(t);
      if (!tf) continue;
      const docDf = df.get(t)!;
      const idf = Math.log(1 + (n - docDf + 0.5) / (docDf + 0.5));
      const normTf = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgLen));
      score += idf * normTf;
    }
    if (hintDays.has(doc.snippet.day)) score = score * 2 + 3; // named the exact day
    const ageDays = Math.max(0, (now.getTime() - Date.parse(doc.snippet.day)) / 86_400_000);
    score *= 1 + 0.25 * Math.exp(-ageDays / 21); // gentle recency boost
    doc.snippet.score = score;
  }

  return docs
    .filter((d) => d.snippet.score > 0)
    .sort((x, y) => y.snippet.score - x.snippet.score)
    .slice(0, limit)
    .map((d) => d.snippet);
}

/** Render retrieved memory as a context block for the system prompt. */
export function formatMemory(snippets: MemorySnippet[]): string {
  if (snippets.length === 0) return '';
  const parts = snippets.map(
    (s, i) =>
      `[memory ${i + 1}] ${s.day}\nUser: ${s.question}\nYou: ${s.answer}`,
  );
  return (
    'Relevant past conversations (from your persistent memory; use them when the ' +
    'user refers to earlier questions, and quote the day when it matters):\n' +
    parts.join('\n\n')
  );
}
