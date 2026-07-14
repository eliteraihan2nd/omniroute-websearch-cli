import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/index.js';
import { executeFetch } from '../src/search.js';

describe('parseArgs fetch command', () => {
  it('captures the URL into query for fetch', () => {
    const parsed = parseArgs(['fetch', 'https://example.com']);
    assert.equal(parsed.command, 'fetch');
    assert.equal(parsed.query, 'https://example.com');
  });

  it('parses --format', () => {
    const parsed = parseArgs(['fetch', 'https://example.com', '--format', 'markdown']);
    assert.equal(parsed.options.format, 'markdown');
  });

  it('parses --depth as raw string (fetch 0|1|2)', () => {
    const parsed = parseArgs(['fetch', 'https://example.com', '--depth', '2']);
    assert.equal(parsed.options.depth, '2');
  });

  it('parses --metadata as boolean flag', () => {
    const parsed = parseArgs(['fetch', 'https://example.com', '--metadata']);
    assert.equal(parsed.options.metadata, true);
  });

  it('parses --selector', () => {
    const parsed = parseArgs(['fetch', 'https://example.com', '--selector', '#main']);
    assert.equal(parsed.options.selector, '#main');
  });

  it('parses --provider for fetch', () => {
    const parsed = parseArgs(['fetch', 'https://example.com', '--provider', 'tavily-search']);
    assert.equal(parsed.options.provider, 'tavily-search');
  });

  it('still captures query for search (regression)', () => {
    const parsed = parseArgs(['search', 'quantum computing']);
    assert.equal(parsed.command, 'search');
    assert.equal(parsed.query, 'quantum computing');
  });
});

describe('executeFetch', () => {
  let fetchMock: ReturnType<typeof mock.method> | undefined;

  afterEach(() => {
    fetchMock?.mock.restore();
    fetchMock = undefined;
  });

  it('POSTs to /v1/web/fetch and returns parsed response', async () => {
    const body = {
      provider: 'tavily-search',
      url: 'https://example.com',
      content: 'hello',
      links: [],
      metadata: {},
      screenshot_url: null,
    };
    fetchMock = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status: 200 }));

    const result = await executeFetch('https://example.com', 'http://base:20128', 'key', {});
    assert.deepEqual(result, body);

    const call = fetchMock.mock.calls[0];
    const [calledUrl, calledInit] = call.arguments as [string, RequestInit];
    assert.equal(calledUrl, 'http://base:20128/v1/web/fetch');
    const sent = JSON.parse(calledInit.body as string);
    assert.equal(sent.url, 'https://example.com');
    assert.equal((calledInit.headers as Record<string, string>)['Authorization'], 'Bearer key');
  });

  it('throws on non-ok response', async () => {
    fetchMock = mock.method(globalThis, 'fetch', async () => new Response('boom', { status: 500 }));
    await assert.rejects(
      () => executeFetch('https://example.com', 'http://base:20128', 'key', {}),
      // Upstream error is forwarded verbatim: status line + raw body, no wrapper.
      /500 \nboom/
    );
  });
});
