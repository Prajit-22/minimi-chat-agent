/**
 * Terminal chat interface. `npm run dev` and talk.
 *
 * Commands:
 *   /new     start a fresh session (memory of past sessions is kept)
 *   /memory <query>   show which past conversations a query would retrieve
 *   /forget  wipe all stored conversation memory
 *   /help    show commands
 *   /quit    exit
 */
import * as readline from 'node:readline/promises';
import { runTurn } from './agent.js';
import { loadConfig } from './config.js';
import { OpenAICompatibleClient } from './llm.js';
import { MemoryStore } from './memory/store.js';
import { retrieveMemory, formatMemory } from './memory/retrieve.js';
import { searchWeb } from './search/index.js';
import type { ChatMessage } from './llm.js';

async function main() {
  const config = loadConfig();
  const llm = new OpenAICompatibleClient(config.llm);
  const store = new MemoryStore(config.memoryDbPath);
  let sessionId = store.createSession();
  let history: ChatMessage[] = [];

  console.log('minimi chat agent - one tool: web search. Type /help for commands.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const shutdown = (): never => {
    store.close();
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);

  for (;;) {
    let line = '';
    try {
      line = (await rl.question('\x1b[1myou>\x1b[0m ')).trim();
    } catch {
      shutdown();
    }
    if (!line) continue;

    if (line === '/quit' || line === '/exit') shutdown();
    if (line === '/help') {
      console.log('/new fresh session | /memory <query> inspect memory | /forget wipe memory | /quit exit');
      continue;
    }
    if (line === '/new') {
      sessionId = store.createSession();
      history = [];
      console.log('(new session started; past conversations are still in memory)');
      continue;
    }
    if (line === '/forget') {
      store.clear();
      sessionId = store.createSession();
      history = [];
      console.log('(memory wiped)');
      continue;
    }
    if (line.startsWith('/memory')) {
      const q = line.slice('/memory'.length).trim();
      const snippets = retrieveMemory(store.allTurns(), q);
      console.log(formatMemory(snippets) || '(nothing in memory matches)');
      continue;
    }

    process.stdout.write('\x1b[1magent>\x1b[0m ');
    try {
      const result = await runTurn({
        userText: line,
        history,
        store,
        sessionId,
        llm,
        search: (query, opts) =>
          searchWeb(query, opts, { braveApiKey: config.braveApiKey, tavilyApiKey: config.tavilyApiKey }),
        onToken: (t) => process.stdout.write(t),
      });
      console.log();
      if (result.sources.length > 0) {
        console.log('\nSources:');
        result.sources.forEach((s, i) => console.log(`  [${i + 1}] ${s.title} - ${s.url}`));
      }
      if (result.searchProvider) {
        console.log(`\x1b[2m(search: ${result.searchProvider})\x1b[0m`);
      }
    } catch (err) {
      console.log(`\nerror: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
