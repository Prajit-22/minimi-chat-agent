/**
 * Web search providers, normalized to one shape.
 *
 * Provider chain: Brave (if BRAVE_API_KEY) -> Tavily (if TAVILY_API_KEY) ->
 * keyless DuckDuckGo HTML. The agent never knows which one answered; results
 * always look the same. Each provider failing falls through to the next.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** ISO date the page was published/crawled, when the provider knows it. */
  published?: string;
}

export type Recency = 'any' | 'day' | 'week' | 'month';

export interface SearchOptions {
  recency?: Recency;
  maxResults?: number;
}

export class ProviderError extends Error {}

const BRAVE_FRESHNESS: Record<Exclude<Recency, 'any'>, string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
};

const TAVILY_DAYS: Record<Exclude<Recency, 'any'>, number> = {
  day: 1,
  week: 7,
  month: 30,
};

export async function searchBrave(
  query: string,
  apiKey: string,
  opts: SearchOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, count: String(opts.maxResults ?? 8) });
  if (opts.recency && opts.recency !== 'any') params.set('freshness', BRAVE_FRESHNESS[opts.recency]);
  const res = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
  });
  if (!res.ok) throw new ProviderError(`Brave search failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string; page_age?: string }> };
  };
  return (data.web?.results ?? [])
    .filter((r) => r.title && r.url)
    .map((r) => ({
      title: r.title!,
      url: r.url!,
      snippet: r.description ?? '',
      published: r.page_age,
    }));
}

export async function searchTavily(
  query: string,
  apiKey: string,
  opts: SearchOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchResult[]> {
  const body: Record<string, unknown> = {
    api_key: apiKey,
    query,
    max_results: opts.maxResults ?? 8,
  };
  if (opts.recency && opts.recency !== 'any') body.days = TAVILY_DAYS[opts.recency];
  const res = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ProviderError(`Tavily search failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
  };
  return (data.results ?? [])
    .filter((r) => r.title && r.url)
    .map((r) => ({
      title: r.title!,
      url: r.url!,
      snippet: r.content ?? '',
      published: r.published_date,
    }));
}

/** Keyless fallback: scrape DuckDuckGo's HTML endpoint. No dates, no guarantees. */
export async function searchDuckDuckGo(
  query: string,
  opts: SearchOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchResult[]> {
  const res = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; minimi-chat-agent/1.0)' },
  });
  if (!res.ok) throw new ProviderError(`DuckDuckGo search failed: HTTP ${res.status}`);
  const html = await res.text();
  const results: SearchResult[] = [];
  const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim();
  const snippets: string[] = [];
  for (const m of html.matchAll(snippetRe)) snippets.push(strip(m[1]!));
  let i = 0;
  for (const m of html.matchAll(blockRe)) {
    let url = m[1]!;
    // DuckDuckGo wraps links in a redirect; unwrap the real target.
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]!);
    results.push({ title: strip(m[2]!), url, snippet: snippets[i] ?? '' });
    i++;
    if (results.length >= (opts.maxResults ?? 8)) break;
  }
  if (results.length === 0) throw new ProviderError('DuckDuckGo returned no parsable results');
  return results;
}
