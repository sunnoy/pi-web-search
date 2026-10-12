import test from 'node:test';
import assert from 'node:assert/strict';
import { callApiStream } from '../src/api.ts';
import { urlContext } from '../src/url_context.ts';
import { webSearch } from '../src/web_search.ts';
import { createModelScopedToolManager } from '../src/index.ts';
import { createMockCtx as mockCtx } from './helpers.mjs';
import { makeResponse } from './fixtures.mjs';

const FETCH_TOOL = {
  type: 'web_fetch_20260318',
  name: 'web_fetch',
  max_uses: 10,
  allowed_callers: ['direct'],
  citations: { enabled: true },
  max_content_tokens: 50000,
};
const SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 10, allowed_callers: ['direct'] };

const anthropicModel = {
  id: 'claude-test',
  provider: 'proxy-provider',
  api: 'anthropic-messages',
  baseUrl: 'https://example.test/anthropic',
  maxTokens: 4096,
  headers: {},
};
const deepseekModel = {
  id: 'deepseek-v4-flash',
  provider: 'deepseek',
  api: 'anthropic-messages',
  baseUrl: 'https://api.deepseek.com',
  maxTokens: 4096,
  headers: {},
};

const PAGE = 'https://example.com/page';
const PDF = 'https://example.com/paper.pdf';

function fetchCallEvents(id, index, url) {
  const json = JSON.stringify({ url });
  return [
    { data: { type: 'content_block_start', index, content_block: { type: 'server_tool_use', id, name: 'web_fetch', input: {} } } },
    { data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 10) } } },
    { data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(10) } } },
    { data: { type: 'content_block_stop', index } },
  ];
}

function fetchResultEvent(id, index, url, title, source = { type: 'text', media_type: 'text/plain', data: 'SECRET-BODY' }) {
  return { data: { type: 'content_block_start', index, content_block: { type: 'web_fetch_tool_result', tool_use_id: id, content: {
    type: 'web_fetch_result', url, retrieved_at: '2026-01-01T00:00:00Z',
    content: { type: 'document', source, ...(title ? { title } : {}) },
  } } } };
}

function textEvents(index, text, citations = []) {
  return [
    { data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } },
    { data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } },
    ...citations.map((citation) => ({ data: { type: 'content_block_delta', index, delta: { type: 'citations_delta', citation } } })),
  ];
}

test('Anthropic web_fetch only: sends fetch tool, records call url and source without body', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body).tools, [FETCH_TOOL]);
    return makeResponse([
      ...fetchCallEvents('srv_f1', 0, PAGE),
      fetchResultEvent('srv_f1', 1, PAGE, 'Example Page'),
      ...textEvents(2, 'The page says hello.'),
    ]);
  });
  const result = await urlContext('id', { query: 'Summarize', urls: [PAGE] }, new AbortController().signal, undefined, mockCtx('test-key', anthropicModel));

  assert.equal(result.details.providerKind, 'anthropic');
  assert.deepEqual(result.details.nativeSearchEvents, [
    'anthropic.content_block_start.server_tool_use.web_fetch',
    'anthropic.content_block_start.web_fetch_tool_result',
  ]);
  const call = result.details.nativeSearchCalls[0];
  assert.equal(call.actionType, 'web_fetch');
  assert.equal(call.status, 'completed');
  assert.deepEqual(call.urls, [PAGE]);
  assert.equal(result.details.searchResults[0].title, 'Example Page');
  assert.equal(result.details.searchResults[0].source, 'anthropic.web_fetch_tool_result');
  assert.equal(result.details.grounded, true);
  assert.deepEqual(result.details.sources, [{ title: 'Example Page', url: PAGE }]);
  assert.doesNotMatch(JSON.stringify(result.details), /SECRET-BODY/);
  assert.doesNotMatch(result.content[0].text, /No verified URL context metadata/);
});

test('Anthropic web_fetch falls back to the URL as title and drops base64 data', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => makeResponse([
    ...fetchCallEvents('srv_f1', 0, PDF),
    fetchResultEvent('srv_f1', 1, PDF, undefined, { type: 'base64', media_type: 'application/pdf', data: 'BASE64-PDF-DATA' }),
    ...textEvents(2, 'A paper.'),
  ]));
  const result = await callApiStream(mockCtx(), anthropicModel, { contents: [{ parts: [{ text: 'Read' }] }] }, undefined, undefined, undefined, [PDF], { search: false, fetch: true });
  assert.equal(result.searchResults[0].title, 'paper.pdf');
  assert.equal(result.searchResults[0].raw.mediaType, 'application/pdf');
  assert.doesNotMatch(JSON.stringify(result), /BASE64-PDF-DATA/);
});

test('web_search with urls on Anthropic enables search and fetch; without urls only search', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    seen.push(JSON.parse(init.body).tools);
    return makeResponse([
      { data: { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'q' } } } },
      { data: { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', title: 'Hit', url: 'https://example.com/hit' }] } } },
      ...fetchCallEvents('srv_f1', 2, PAGE),
      fetchResultEvent('srv_f1', 3, PAGE, 'Example Page'),
      ...textEvents(4, 'Combined answer.'),
    ]);
  });
  const ctx = mockCtx('test-key', anthropicModel);
  const withUrls = await webSearch('id', { query: 'q', urls: [PAGE] }, new AbortController().signal, undefined, ctx);
  await webSearch('id', { query: 'q' }, new AbortController().signal, undefined, ctx);

  assert.deepEqual(seen[0], [SEARCH_TOOL, FETCH_TOOL]);
  assert.deepEqual(seen[1], [SEARCH_TOOL]);
  assert.deepEqual(withUrls.details.searchQueries, ['q']);
  assert.deepEqual(withUrls.details.nativeSearchCalls.map((call) => call.actionType), ['web_search', 'web_fetch']);
  assert.deepEqual(withUrls.details.searchResults.map((item) => item.url), ['https://example.com/hit', PAGE]);
});

test('Anthropic web_fetch error records the error code', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => makeResponse([
    ...fetchCallEvents('srv_f1', 0, PAGE),
    { data: { type: 'content_block_start', index: 1, content_block: { type: 'web_fetch_tool_result', tool_use_id: 'srv_f1', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } } } },
    ...textEvents(2, 'Could not read it.'),
  ]));
  const result = await urlContext('id', { query: 'Summarize', urls: [PAGE] }, new AbortController().signal, undefined, mockCtx('test-key', anthropicModel));
  const failure = result.details.searchResults[0];
  assert.equal(failure.status, 'url_not_accessible');
  assert.equal(failure.source, 'anthropic.web_fetch_tool_result_error');
  assert.equal(result.details.nativeSearchCalls[0].status, 'completed');
  assert.equal(result.details.grounded, true);
  assert.deepEqual(result.details.sources, []);
});

test('Anthropic char_location citations map to fetched documents by title, then index', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => makeResponse([
    ...fetchCallEvents('srv_f1', 0, PAGE),
    fetchResultEvent('srv_f1', 1, PAGE, 'Page One'),
    ...fetchCallEvents('srv_f2', 2, PDF),
    fetchResultEvent('srv_f2', 3, PDF, 'Paper Two'),
    ...textEvents(4, 'Alpha fact. Beta fact. Gamma fact. Unknown fact.', [
      { type: 'char_location', cited_text: 'Beta fact.', document_index: 0, document_title: 'Paper Two', start_char_index: 0, end_char_index: 5 },
      { type: 'char_location', cited_text: 'Alpha fact.', document_index: 0, document_title: 'Missing title', start_char_index: 0, end_char_index: 5 },
      { type: 'char_location', cited_text: 'Gamma fact.', document_index: 9, document_title: 'Nope', start_char_index: 0, end_char_index: 5 },
    ]),
  ]));
  const result = await urlContext('id', { query: 'q', urls: [PAGE, PDF] }, new AbortController().signal, undefined, mockCtx('test-key', anthropicModel));
  const byText = Object.fromEntries(result.details.citations.filter((c) => c.citedText).map((c) => [c.citedText, c.url]));
  assert.equal(byText['Beta fact.'], PDF);
  assert.equal(byText['Alpha fact.'], PAGE);
  assert.equal('Gamma fact.' in byText, false);
  assert.match(result.content[0].text, /Beta fact\.\[\d\]/);
});

test('DeepSeek never gets the web_fetch tool', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body).tools, [SEARCH_TOOL]);
    return makeResponse(textEvents(0, 'ok'));
  });
  const ctx = mockCtx('test-key', deepseekModel);
  await callApiStream(ctx, deepseekModel, { contents: [{ parts: [{ text: 'q' }] }] }, undefined, undefined, undefined, [PAGE], { search: true, fetch: true });
  await webSearch('id', { query: 'q', urls: [PAGE] }, new AbortController().signal, undefined, ctx);
});

test('url_context on DeepSeek still reports unsupported, and the tool stays hidden', async () => {
  const result = await urlContext('id', { query: 'q', urls: [PAGE] }, new AbortController().signal, undefined, mockCtx('test-key', deepseekModel));
  assert.equal(result.details.error, 'unsupported_provider');
  assert.match(result.content[0].text, /Anthropic/);

  for (const [model, expectActive] of [[deepseekModel, false], [anthropicModel, true]]) {
    let active = ['web_search', 'url_context'];
    const manager = createModelScopedToolManager({ getActiveTools: () => active, setActiveTools: (tools) => { active = tools; } });
    manager.sync(model);
    assert.equal(active.includes('url_context'), expectActive);
  }
});
