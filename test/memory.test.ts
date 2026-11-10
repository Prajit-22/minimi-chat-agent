import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/memory/store.js';
import { retrieveMemory, formatMemory, buildDocs } from '../src/memory/retrieve.js';

function seededStore() {
  const store = new MemoryStore(':memory:');
  const s1 = store.createSession();
  store.addTurn(s1, 'user', 'What is the best Postgres hosting for a small SaaS?', new Date(2026, 10, 3, 10));
  store.addTurn(s1, 'assistant', 'I compared Neon, Supabase and RDS. Neon was cheapest at your scale [1].', new Date(2026, 10, 3, 10));
  const s2 = store.createSession();
  store.addTurn(s2, 'user', 'Help me shortlist CRM tools for a 20-person sales team', new Date(2026, 10, 9, 15));
  store.addTurn(s2, 'assistant', 'We shortlisted HubSpot, Pipedrive, Salesforce Starter, Zoho CRM and Attio.', new Date(2026, 10, 9, 15));
  return store;
}

test('store persists turns with their calendar day', () => {
  const store = seededStore();
  assert.equal(store.allTurns().length, 4);
  assert.equal(store.turnsOnDay('2026-11-03').length, 2);
  assert.equal(store.turnsOnDay('2026-11-09')[0]!.content, 'Help me shortlist CRM tools for a 20-person sales team');
  store.clear();
  assert.equal(store.allTurns().length, 0);
  store.close();
});

test('retrieval ranks the semantically matching exchange first', () => {
  const store = seededStore();
  const hits = retrieveMemory(store.allTurns(), 'has Postgres hosting pricing changed?');
  assert.equal(hits.length > 0, true);
  assert.match(hits[0]!.question, /Postgres hosting/);
  store.close();
});

test('an exact day mentioned in the query boosts that day', () => {
  const store = seededStore();
  const hits = retrieveMemory(store.allTurns(), 'what did we talk about?', {
    hintDays: ['2026-11-03'],
  });
  assert.equal(hits[0]!.day, '2026-11-03');
  store.close();
});

test('buildDocs pairs user questions with the assistant reply', () => {
  const store = seededStore();
  const docs = buildDocs(store.allTurns());
  assert.equal(docs.length, 2);
  assert.match(docs[0]!.snippet.answer, /Neon was cheapest/);
  store.close();
});

test('formatMemory labels each snippet with its day', () => {
  const store = seededStore();
  const out = formatMemory(retrieveMemory(store.allTurns(), 'CRM tools'));
  assert.match(out, /\[memory 1\] 2026-11-09/);
  store.close();
});
