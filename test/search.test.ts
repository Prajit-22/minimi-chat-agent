import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchWeb, dedupeResults } from '../src/search/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const bravePayload = {
  web: {
    results: [
      { title: 'HubSpot Pricing', url: 'https://www.hubspot.com/pricing', description: 'Plans from $20.', page_age: '2026-11-08T00:00:00Z' },
      { title: 'HubSpot Pricing', url: 'https://www.hubspot.com/pricing?utm=x', description: 'Duplicate.', page_age: '2026-11-08T00:00:00Z' },
    ],
  },
};

const ddgHtml = `
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fneon.tech%2Fpricing&amp;rut=x">Neon Pricing</a>
  <a class="result__snippet" href="#">Serverless Postgres, free tier.</a>
  <a class="result__a" href="https://supabase.com/pricing">Supabase Pricing</a>
  <a class="result__snippet" href="#">Hosted Postgres.</a>
`;

test('brave results are normalized and deduped', async () => {
  const fetchImpl = (async () => jsonResponse(bravePayload)) as typeof fetch;
  const out = await searchWeb('hubspot pricing', {}, { braveApiKey: 'k' }, fetchImpl);
  assert.equal(out.provider, 'brave');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0]!.published, '2026-11-08T00:00:00Z');
});

test('a failing keyed provider falls through to the next one', async () => {
  const fetchImpl = (async (input: any) => {
    const url = String(input);
    if (url.includes('brave.com')) return jsonResponse({ message: 'nope' }, 401);
    if (url.includes('tavily.com')) {
      return jsonResponse({ results: [{ title: 'T', url: 'https://x.dev', content: 'c', published_date: '2026-11-01' }] });
    }
    throw new Error('unexpected url ' + url);
  }) as typeof fetch;
  const out = await searchWeb('q', {}, { braveApiKey: 'bad', tavilyApiKey: 'k2' }, fetchImpl);
  assert.equal(out.provider, 'tavily');
  assert.equal(out.results[0]!.url, 'https://x.dev');
});

test('with no keys, keyless DuckDuckGo HTML is parsed and unwrapped', async () => {
  const fetchImpl = (async () => new Response(ddgHtml, { status: 200 })) as typeof fetch;
  const out = await searchWeb('postgres hosting', {}, {}, fetchImpl);
  assert.equal(out.provider, 'duckduckgo');
  assert.equal(out.results[0]!.url, 'https://neon.tech/pricing');
  assert.match(out.results[0]!.snippet, /Serverless Postgres/);
  assert.equal(out.results[1]!.url, 'https://supabase.com/pricing');
});

test('all providers failing raises one aggregated error', async () => {
  const fetchImpl = (async () => jsonResponse({}, 500)) as typeof fetch;
  await assert.rejects(
    () => searchWeb('q', {}, { braveApiKey: 'k' }, fetchImpl),
    /All search providers failed/,
  );
});

test('dedupeResults keys on host + path', () => {
  const out = dedupeResults([
    { title: 'a', url: 'https://www.example.com/p/', snippet: '' },
    { title: 'b', url: 'https://example.com/p', snippet: '' },
    { title: 'c', url: 'https://example.com/other', snippet: '' },
  ]);
  assert.equal(out.length, 2);
});
