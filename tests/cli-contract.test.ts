import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigurationError, loadConfig } from '../src/config.js';
import { parseArgs, runCli } from '../src/index.js';
import { executeFetch, executeSearch } from '../src/search.js';

const configVariables = [
  'OMNIROUTE_WEBSEARCH_URL',
  'OMNIROUTE_WEBSEARCH_API_KEY',
  'OMNIROUTE_WEBSEARCH_PROVIDERS',
  'XDG_CONFIG_HOME',
  'HOME',
] as const;

const originalEnvironment = new Map(
  configVariables.map((name) => [name, process.env[name]]),
);

let fetchMock: ReturnType<typeof mock.method> | undefined;
let logMock: ReturnType<typeof mock.method> | undefined;

afterEach(() => {
  fetchMock?.mock.restore();
  logMock?.mock.restore();
  fetchMock = undefined;
  logMock = undefined;

  for (const [name, value] of originalEnvironment) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

function mockJsonResponse(body: unknown): void {
  fetchMock = mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify(body), { status: 200 }),
  );
}

describe('CLI JSON and environment contract', () => {
  it('requires OMNIROUTE_WEBSEARCH_API_KEY alongside the URL and never falls back to a config file', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'omni-websearch-test-'));
    await writeFile(
      join(configHome, 'config'),
      'OMNIROUTE_WEBSEARCH_URL=https://file.example\nOMNIROUTE_WEBSEARCH_API_KEY=file-key\n',
    );
    process.env.XDG_CONFIG_HOME = configHome;
    delete process.env.OMNIROUTE_WEBSEARCH_URL;
    delete process.env.OMNIROUTE_WEBSEARCH_API_KEY;

    try {
      await assert.rejects(
        () => loadConfig(),
        (error: unknown) => error instanceof ConfigurationError,
      );
    } finally {
      await rm(configHome, { force: true, recursive: true });
    }
  });

  it('loads both credentials from the environment without touching the config path', async () => {
    process.env.OMNIROUTE_WEBSEARCH_URL = 'https://env.example';
    process.env.OMNIROUTE_WEBSEARCH_API_KEY = 'env-key';
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.HOME;

    const config = await loadConfig();

    assert.equal(config.omniRouteUrl, 'https://env.example');
    assert.equal(config.omniRouteApiKey, 'env-key');
  });

  it('posts search requests to exactly one v1 path when the base URL has no v1 suffix', async () => {
    mockJsonResponse([]);

    await executeSearch('test query', undefined, 3, 'https://omni.example', 'key');

    assert.equal(fetchMock?.mock.calls[0]?.arguments[0], 'https://omni.example/v1/search');
  });

  it('posts search requests to exactly one v1 path when the base URL has a v1 suffix', async () => {
    mockJsonResponse([]);

    await executeSearch('test query', undefined, 3, 'https://omni.example/v1', 'key');

    assert.equal(fetchMock?.mock.calls[0]?.arguments[0], 'https://omni.example/v1/search');
  });

  it('posts fetch requests to exactly one v1 path when the base URL has no v1 suffix', async () => {
    mockJsonResponse({ provider: 'exa-search', url: 'https://example.com', content: 'text' });

    await executeFetch('https://example.com', 'https://omni.example', 'key');

    assert.equal(fetchMock?.mock.calls[0]?.arguments[0], 'https://omni.example/v1/web/fetch');
  });

  it('posts fetch requests to exactly one v1 path when the base URL has a v1 suffix', async () => {
    mockJsonResponse({ provider: 'exa-search', url: 'https://example.com', content: 'text' });

    await executeFetch('https://example.com', 'https://omni.example/v1', 'key');

    assert.equal(fetchMock?.mock.calls[0]?.arguments[0], 'https://omni.example/v1/web/fetch');
  });

  it('forwards an upstream search error body without converting it to a success payload', async () => {
    fetchMock = mock.method(
      globalThis,
      'fetch',
      async () => new Response('provider unavailable', { status: 503, statusText: 'Service Unavailable' }),
    );

    await assert.rejects(
      () => executeSearch('test query', 'exa-search', 3, 'https://omni.example', 'key'),
      /503 Service Unavailable\nprovider unavailable/,
    );
  });

  it('rejects a malformed successful fetch response', async () => {
    fetchMock = mock.method(
      globalThis,
      'fetch',
      async () => new Response('{not-json', { status: 200 }),
    );

    await assert.rejects(
      () => executeFetch('https://example.com', 'https://omni.example', 'key'),
    );
  });

  it('rejects invalid and unknown command arguments before any request', () => {
    assert.throws(() => parseArgs(['search', 'test', '--max', 'three']), /Invalid --max value/);
    assert.throws(() => parseArgs(['search', 'test', '--unknown']), /Unknown option/);
  });

  it('emits a machine-readable JSON search result on standard output', async () => {
    process.env.OMNIROUTE_WEBSEARCH_URL = 'https://omni.example';
    process.env.OMNIROUTE_WEBSEARCH_API_KEY = 'key';
    mockJsonResponse([
      { title: 'Result', url: 'https://result.example', snippet: 'summary' },
    ]);
    const output: string[] = [];
    logMock = mock.method(console, 'log', (...values: unknown[]) => {
      output.push(values.map(String).join(' '));
    });

    await runCli(['search', 'query', '--json']);

    assert.deepEqual(JSON.parse(output[0] ?? ''), [{
      title: 'Result',
      url: 'https://result.example',
      snippet: 'summary',
    }]);
  });

  it('sends a provider from OMNIROUTE_WEBSEARCH_PROVIDERS on single search when --provider is absent', async () => {
    process.env.OMNIROUTE_WEBSEARCH_URL = 'https://omni.example';
    process.env.OMNIROUTE_WEBSEARCH_API_KEY = 'key';
    process.env.OMNIROUTE_WEBSEARCH_PROVIDERS = 'exa-search,tavily-search';
    // --seed 5 makes the weighted draw deterministic; with weights
    // { 'exa-search': 2, 'tavily-search': 1 } the pick is exa-search.
    mockJsonResponse([]);

    await runCli(['search', 'query', '--seed', '5']);

    const requestBody = JSON.parse(String((fetchMock?.mock.calls[0]?.arguments[1] as RequestInit | undefined)?.body));
    assert.equal(requestBody.provider, 'exa-search');
  });
});
