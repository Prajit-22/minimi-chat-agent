# minimi chat agent

A chat agent with exactly one tool: **web search**. Built for the minimi
hiring challenge.

It remembers past conversations (and what day they happened), resolves
relative dates like "last Tuesday" deterministically, and re-verifies old
answers with fresh searches when you ask "is that still true?".

See [DESIGN.md](DESIGN.md) for the architecture and the reasoning behind it.

## Run it

Requires Node.js >= 22.5.

```bash
npm install
cp .env.example .env   # add your keys
npm run dev
```

You need one model key (any OpenAI-compatible API with tool calling; the
free Groq tier works) and optionally a search key. With no search key it
falls back to keyless DuckDuckGo, so it works out of the box.

| Variable | Required | Purpose |
| --- | --- | --- |
| `LLM_API_KEY` | yes | Key for the model API |
| `LLM_BASE_URL` | no | Defaults to Groq; any OpenAI-compatible endpoint |
| `LLM_MODEL` | no | Defaults to `openai/gpt-oss-20b` |
| `BRAVE_API_KEY` | no | Brave Search; used first when set |
| `TAVILY_API_KEY` | no | Used when Brave is unset or fails |
| `MEMORY_DB` | no | Where conversation memory is stored (default `./memory.db`) |

## Talking to it

```
you> help me shortlist Postgres hosting for a small SaaS
agent> ... (searches, compares, cites sources)

you> what did I ask you on 3 November? is your answer still correct today?
agent> ... (recalls the exchange from memory, searches again, tells you what changed)
```

Commands: `/new` (fresh session, memory kept), `/memory <query>` (inspect
what a query would retrieve), `/forget` (wipe memory), `/quit`.

## Tests

```bash
npm test          # 25 tests: dates, memory, search, SSE parsing, the agent loop
npm run typecheck
```

Tests use a scripted fake model and fake search backends; no network, no keys.

## Layout

```
src/
  cli.ts              terminal chat interface
  agent.ts            the agent loop: context -> model -> tools -> answer
  prompt.ts           system prompt assembly
  dates.ts            deterministic relative-date resolution
  llm.ts              hand-written OpenAI-compatible streaming client
  memory/store.ts     SQLite persistence (node:sqlite)
  memory/retrieve.ts  BM25-style recall over past conversations
  search/             one tool, three providers behind one normalized shape
```

## Limitations

- Memory retrieval is lexical; very large histories would want embeddings.
- Search returns snippets, not full pages; conflicting claims across pages
  are surfaced, not adjudicated.
- The keyless DuckDuckGo fallback has no publication dates and can break if
  their HTML changes; set `BRAVE_API_KEY` or `TAVILY_API_KEY` for real use.
