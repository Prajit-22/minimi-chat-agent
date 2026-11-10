import { readFileSync, existsSync } from 'node:fs';

export interface AppConfig {
  llm: { baseUrl: string; apiKey: string; model: string };
  braveApiKey?: string;
  tavilyApiKey?: string;
  memoryDbPath: string;
}

/** Minimal .env parser - one less dependency for a take-home reviewers run. */
function loadDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) out[key] = value;
  }
  return out;
}

function pick(env: Record<string, string>, key: string): string | undefined {
  const v = process.env[key] ?? env[key];
  return v && v.length > 0 ? v : undefined;
}

export function loadConfig(envPath = '.env'): AppConfig {
  const fileEnv = loadDotEnv(envPath);
  const apiKey = pick(fileEnv, 'LLM_API_KEY');
  if (!apiKey) {
    throw new Error(
      'LLM_API_KEY is not set. Copy .env.example to .env and add a key for any ' +
      'OpenAI-compatible API (Groq free tier works: https://console.groq.com/keys).',
    );
  }
  return {
    llm: {
      baseUrl: (pick(fileEnv, 'LLM_BASE_URL') ?? 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
      apiKey,
      model: pick(fileEnv, 'LLM_MODEL') ?? 'openai/gpt-oss-20b',
    },
    braveApiKey: pick(fileEnv, 'BRAVE_API_KEY'),
    tavilyApiKey: pick(fileEnv, 'TAVILY_API_KEY'),
    memoryDbPath: pick(fileEnv, 'MEMORY_DB') ?? './memory.db',
  };
}
