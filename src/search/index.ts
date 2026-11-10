import {
  ProviderError,
  searchBrave,
  searchDuckDuckGo,
  searchTavily,
  type SearchOptions,
  type SearchResult,
} from './providers.js';

export type { Recency, SearchOptions, SearchResult } from './providers.js';

export interface SearchConfig {
  braveApiKey?: string;
  tavilyApiKey?: string;
}

export interface SearchOutcome {
  provider: string;
  results: SearchResult[];
}

/** Remove duplicate URLs (same host + path), keeping the first occurrence. */
export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    let key: string;
    try {
      const u = new URL(r.url);
      key = u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
    } catch {
      key = r.url;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * The agent's one tool. Tries providers in order and falls through on error,
 * so a missing or expired key degrades the answer instead of breaking the run.
 */
export async function searchWeb(
  query: string,
  opts: SearchOptions,
  config: SearchConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchOutcome> {
  const attempts: Array<() => Promise<{ provider: string; results: SearchResult[] }>> = [];
  if (config.braveApiKey) {
    attempts.push(async () => ({
      provider: 'brave',
      results: await searchBrave(query, config.braveApiKey!, opts, fetchImpl),
    }));
  }
  if (config.tavilyApiKey) {
    attempts.push(async () => ({
      provider: 'tavily',
      results: await searchTavily(query, config.tavilyApiKey!, opts, fetchImpl),
    }));
  }
  attempts.push(async () => ({
    provider: 'duckduckgo',
    results: await searchDuckDuckGo(query, opts, fetchImpl),
  }));

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const { provider, results } = await attempt();
      return { provider, results: dedupeResults(results) };
    } catch (err) {
      if (err instanceof ProviderError) errors.push(err.message);
      else throw err;
    }
  }
  throw new ProviderError(`All search providers failed: ${errors.join('; ')}`);
}
