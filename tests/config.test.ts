import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resolveBaseUrl, ConfigurationError, getWeightedRandom } from '../src/config.js';

const envVars = ['OMNIROUTE_WEBSEARCH_URL', 'OMNIROUTE_WEBSEARCH_API_KEY', 'OMNIROUTE_WEBSEARCH_PROVIDERS'];

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe('loadConfig', () => {
  beforeEach(() => {
    for (const key of envVars) setEnv(key, undefined);
  });

  afterEach(() => {
    mock.restoreAll();
    for (const key of envVars) setEnv(key, undefined);
  });

  it('throws ConfigurationError when the required env vars are missing', async () => {
    await assert.rejects(
      () => loadConfig(),
      (error: unknown) => error instanceof ConfigurationError && error.message.includes('OMNIROUTE_WEBSEARCH_URL')
    );
  });

  it('throws ConfigurationError when only the API key is set', async () => {
    setEnv('OMNIROUTE_WEBSEARCH_API_KEY', 'sk-test');
    await assert.rejects(
      () => loadConfig(),
      (error: unknown) => error instanceof ConfigurationError && error.message.includes('OMNIROUTE_WEBSEARCH_URL')
    );
  });

  it('throws ConfigurationError when only the URL is set', async () => {
    setEnv('OMNIROUTE_WEBSEARCH_URL', 'https://omniroute.example.com');
    await assert.rejects(
      () => loadConfig(),
      (error: unknown) => error instanceof ConfigurationError && error.message.includes('OMNIROUTE_WEBSEARCH_API_KEY')
    );
  });

  it('throws ConfigurationError for a whitespace-only URL', async () => {
    setEnv('OMNIROUTE_WEBSEARCH_URL', '   ');
    setEnv('OMNIROUTE_WEBSEARCH_API_KEY', 'sk-test');
    await assert.rejects(
      () => loadConfig(),
      (error: unknown) => error instanceof ConfigurationError
    );
  });

  it('returns the required config when both env vars are set', async () => {
    setEnv('OMNIROUTE_WEBSEARCH_URL', 'https://omniroute.example.com');
    setEnv('OMNIROUTE_WEBSEARCH_API_KEY', 'sk-test');
    const config = await loadConfig();
    assert.equal(config.omniRouteUrl, 'https://omniroute.example.com');
    assert.equal(config.omniRouteApiKey, 'sk-test');
    assert.equal(config.timeout, 30000);
    assert.equal(config.providers, undefined);
  });

  it('parses OMNIROUTE_WEBSEARCH_PROVIDERS into a weighted map (first = highest weight)', async () => {
    setEnv('OMNIROUTE_WEBSEARCH_URL', 'https://omniroute.example.com');
    setEnv('OMNIROUTE_WEBSEARCH_API_KEY', 'sk-test');
    setEnv('OMNIROUTE_WEBSEARCH_PROVIDERS', 'tavily-search,exa-search,brave-search');
    const config = await loadConfig();
    assert.deepEqual(config.providers, { 'tavily-search': 3, 'exa-search': 2, 'brave-search': 1 });
  });

  it('ignores an empty OMNIROUTE_WEBSEARCH_PROVIDERS value', async () => {
    setEnv('OMNIROUTE_WEBSEARCH_URL', 'https://omniroute.example.com');
    setEnv('OMNIROUTE_WEBSEARCH_API_KEY', 'sk-test');
    setEnv('OMNIROUTE_WEBSEARCH_PROVIDERS', '');
    const config = await loadConfig();
    assert.equal(config.providers, undefined);
  });

  it('fails fast on a malformed URL', async () => {
    setEnv('OMNIROUTE_WEBSEARCH_URL', 'not-a-url');
    setEnv('OMNIROUTE_WEBSEARCH_API_KEY', 'sk-test');
    await assert.rejects(
      () => loadConfig(),
      (error: unknown) => error instanceof ConfigurationError
    );
  });
});

describe('resolveBaseUrl', () => {
  it('returns a bare host URL unchanged (callers append /v1)', () => {
    assert.equal(resolveBaseUrl('https://omniroute.example.com'), 'https://omniroute.example.com');
  });

  it('strips a trailing /v1 so callers never construct /v1/v1', () => {
    assert.equal(resolveBaseUrl('https://omniroute.example.com/v1'), 'https://omniroute.example.com');
  });

  it('strips a trailing slash before /v1', () => {
    assert.equal(resolveBaseUrl('https://omniroute.example.com/v1/'), 'https://omniroute.example.com');
  });

  it('strips a trailing slash on a bare host', () => {
    assert.equal(resolveBaseUrl('https://omniroute.example.com/'), 'https://omniroute.example.com');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(resolveBaseUrl('  https://omniroute.example.com/v1  '), 'https://omniroute.example.com');
  });

  it('throws ConfigurationError for an invalid URL', () => {
    assert.throws(
      () => resolveBaseUrl('not-a-url'),
      (error: unknown) => error instanceof ConfigurationError
    );
  });
});

describe('getWeightedRandom', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  // Bounds of the weighted ranges for { 'tavily-search': 3, 'exa-search': 2,
  // 'brave-search': 1 } with total weight 6:
  //   draw ∈ [0, 3/6)   → tavily-search
  //   draw ∈ [3/6, 5/6) → exa-search
  //   draw ∈ [5/6, 1)   → brave-search
  const draw = (value: number) => mock.method(Math, 'random', () => value);

  const providers = { 'tavily-search': 3, 'exa-search': 2, 'brave-search': 1 };

  it('selects the first provider when the draw lands in its range', () => {
    draw(0);
    assert.equal(getWeightedRandom(providers), 'tavily-search');
  });

  it('selects a later provider when the draw falls outside earlier ranges', () => {
    draw(4 / 6);
    assert.equal(getWeightedRandom(providers), 'exa-search');
  });

  it('returns the last provider for a draw at the top of the range', () => {
    draw(1);
    assert.equal(getWeightedRandom(providers), 'brave-search');
  });

  it('returns undefined when every provider is disabled (weight <= 0)', () => {
    draw(0);
    assert.equal(getWeightedRandom({ 'exa-search': 0, 'tavily-search': -1 }), undefined);
  });

  it('returns undefined for an empty provider map', () => {
    draw(0);
    assert.equal(getWeightedRandom({}), undefined);
  });
});
