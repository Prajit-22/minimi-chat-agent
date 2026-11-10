# DESIGN.md

A chat agent with exactly one tool: web search. This page explains how it
works, why it is built this way, what I considered and rejected, and what I
would do with another week.

## How it works

```
user message
    |
    v
1. date grounding      "last Tuesday", "on 3 November" are resolved in code
    |                  against the local clock and injected as absolute dates
    v
2. memory retrieval    past conversations live in SQLite; BM25-style lexical
    |                  search finds the relevant ones (exact-day boost when the
    |                  user names a date) and injects them into the prompt
    v
3. agent loop          model + one tool (web_search); up to 6 model steps,
    |                  searches in the same step run in parallel, the final
    |                  step drops the tool so the model must answer
    v
4. answer              streamed token by token, citations [n] matching the
                       numbered search results; the exchange is written to memory
```

Everything is TypeScript on Node (>= 22.5) with **zero runtime
dependencies**: the LLM client is a hand-written OpenAI-compatible streaming
client over `fetch` + SSE, memory is `node:sqlite`, tests run on
`node:test`. `npm install` only pulls dev tooling (tsx, typescript).

## Why it is built this way

**Memory is context, not a tool.** The rules give me one tool, and I spent it
on web search. But the test dataset ("what did I ask you on 3 November? is it
still correct?") demands memory. So memory is injected automatically before
every answer: the agent can always recall, and can always spend its one tool
on re-verifying. Each turn is stored with its local calendar day, so "on 3
November" becomes an exact lookup, not a fuzzy one.

**Dates are resolved in code, never by the model.** Models are unreliable at
date arithmetic. `src/dates.ts` deterministically resolves the common
relative-date phrases ("last Tuesday", "3 days ago", "on 3 November") and
hands the model absolute dates. This is the difference between "still
correct?" triggering a genuinely fresh comparison and a hallucinated one.

**Retrieval is lexical (BM25-style), not embeddings.** At conversation scale
(hundreds of turns), BM25 over past exchanges is instant, deterministic,
needs no second API key, and is easy to debug. Queries here name entities and
dates explicitly, which is exactly what lexical search is good at. A recency
boost and an exact-day boost handle the ranking cases BM25 alone misses.

**One search tool, a provider chain behind it.** Brave if `BRAVE_API_KEY` is
set, else Tavily, else a keyless DuckDuckGo scrape, so the agent runs out of
the box with only a model key. Results are normalized (title, url, snippet,
published date) and deduped, so the model always sees the same shape.
Published dates matter: "has pricing changed since Monday?" can only be
answered if the model can see *when* each result is from.

**Speed is a feature.** Tokens stream to the terminal as they arrive;
independent searches in one step run in parallel; a same-query guard stops
the model burning steps on identical searches; the step cap guarantees a
bounded answer time.

## Considered and rejected

- **LangChain / an agent framework**: for one tool and one loop it adds
  opacity and a heavy dependency tree; the whole loop here is ~100 readable
  lines I can defend line by line.
- **Vector memory with embeddings**: better recall at huge scale, but needs
  an embedding model/key, is nondeterministic, and is overkill for hundreds
  of turns. Lexical + exact-day indexing fits this problem.
- **Fetching full pages inside search**: better evidence, but doubles
  latency on every search. Snippets with dates answer most "did it change"
  questions; I would add page reading behind a flag, not by default.
- **Memory as a second tool**: violates the spirit of the one-tool rule and
  makes recall depend on the model remembering to remember.

## With another week

- An eval suite built from questions like the dataset's, run in CI, so
  prompt and retrieval changes are measured, not vibes.
- Optional full-page reading for the top result when snippets disagree.
- Session summaries so very long histories stay within the context window.
- A small web UI on the same agent core.
