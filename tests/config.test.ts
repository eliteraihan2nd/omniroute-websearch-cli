import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveConfig, parseKeyValueFile, configPaths, resolveBaseUrl, ConfigurationError, getWeightedRandom } from '../src/config.js';

const envVars = ['OMNIROUTE_CUSTOM_WEBSEARCH_URL', 'OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY', 'OMNIROUTE_CUSTOM_WEBSEARCH_PROVIDERS'];

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/**
 * Point XDG_CONFIG_HOME at a throwaway directory so tests never read the
 * developer's real ~/.config/omni-websearch.
 */
let tmpHome: string | undefined;
const originalXdg = process.env.XDG_CONFIG_HOME;

function useTempConfigHome(): void {
  tmpHome = mkdtempSync(join(tmpdir(), 'omni-websearch-test-'));
  process.env.XDG_CONFIG_HOME = tmpHome;
}

/** Write one of the two config files into the temp config home, mode 600. */
function writeConfigFile(name: 'config' | 'credentials', body: string): string {
  const dir = join(process.env.XDG_CONFIG_HOME as string, 'omni-websearch');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, body, { mode: 0o600 });
  return file;
}

function restoreEnv(): void {
  for (const key of envVars) setEnv(key, undefined);
  setEnv('XDG_CONFIG_HOME', originalXdg);
  if (tmpHome !== undefined) rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = undefined;
}

describe('loadConfig', () => {
  beforeEach(() => {
    useTempConfigHome();
    for (const key of envVars) setEnv(key, undefined);
  });

  afterEach(() => {
    mock.restoreAll();
    restoreEnv();
  });

  it('throws ConfigurationError when the required env vars are missing', async () => {
    await assert.rejects(
      () => loadConfig(),
      (error: unknown) => error instanceof ConfigurationError && error.message.includes('OMNIROUTE_CUSTOM_WEBSEARCH_URL')
    );
  });

  it('throws ConfigurationError when only the API key is set', async () => {
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY', 'sk-test');
    await assert.rejects(
      () => loadConfig(),
      (error: unknown) => error instanceof ConfigurationError && error.message.includes('OMNIROUTE_CUSTOM_WEBSEARCH_URL')
    );
  });

  it('throws ConfigurationError when only the URL is set', async () => {
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_URL', 'https://omniroute.example.com');
    await assert.rejects(
      () => loadConfig(),
      (error: unknown) => error instanceof ConfigurationError && error.message.includes('OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY')
    );
  });

  it('throws ConfigurationError for a whitespace-only URL', async () => {
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_URL', '   ');
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY', 'sk-test');
    await assert.rejects(
      () => loadConfig(),
      (error: unknown) => error instanceof ConfigurationError
    );
  });

  it('returns the required config when both env vars are set', async () => {
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_URL', 'https://omniroute.example.com');
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY', 'sk-test');
    const config = await loadConfig();
    assert.equal(config.omniRouteUrl, 'https://omniroute.example.com');
    assert.equal(config.omniRouteApiKey, 'sk-test');
    assert.equal(config.timeout, 30000);
    assert.equal(config.providers, undefined);
  });

  it('parses OMNIROUTE_CUSTOM_WEBSEARCH_PROVIDERS into a weighted map (first = highest weight)', async () => {
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_URL', 'https://omniroute.example.com');
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY', 'sk-test');
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_PROVIDERS', 'tavily-search,exa-search,brave-search');
    const config = await loadConfig();
    assert.deepEqual(config.providers, { 'tavily-search': 3, 'exa-search': 2, 'brave-search': 1 });
  });

  it('ignores an empty OMNIROUTE_CUSTOM_WEBSEARCH_PROVIDERS value', async () => {
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_URL', 'https://omniroute.example.com');
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY', 'sk-test');
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_PROVIDERS', '');
    const config = await loadConfig();
    assert.equal(config.providers, undefined);
  });

  it('fails fast on a malformed URL', async () => {
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_URL', 'not-a-url');
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY', 'sk-test');
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

describe('config sources (precedence)', () => {
  const FILE_URL = 'https://from-file.example.com/v1';

  beforeEach(() => {
    useTempConfigHome();
    for (const key of envVars) setEnv(key, undefined);
  });

  afterEach(() => {
    mock.restoreAll();
    restoreEnv();
  });

  it('reads url, providers and key from the files when the environment is empty', () => {
    writeConfigFile('config', `# comment\nOMNIROUTE_CUSTOM_WEBSEARCH_URL=${FILE_URL}\nOMNIROUTE_CUSTOM_WEBSEARCH_PROVIDERS=exa-search,tavily-search\n`);
    writeConfigFile('credentials', 'OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY=sk-file\n');
    const { config, provenance } = resolveConfig();
    assert.equal(config.omniRouteUrl, 'https://from-file.example.com');
    assert.deepEqual(config.providers, { 'exa-search': 2, 'tavily-search': 1 });
    assert.equal(config.omniRouteApiKey, 'sk-file');
    assert.match(provenance.url, /config$/);
    assert.match(provenance.apiKey, /credentials$/);
  });

  it('lets the environment win over the files', () => {
    writeConfigFile('config', `OMNIROUTE_CUSTOM_WEBSEARCH_URL=${FILE_URL}\n`);
    writeConfigFile('credentials', 'OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY=sk-file\n');
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_URL', 'https://from-env.example.com');
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY', 'sk-env');
    const { config, provenance } = resolveConfig();
    assert.equal(config.omniRouteUrl, 'https://from-env.example.com');
    assert.equal(config.omniRouteApiKey, 'sk-env');
    assert.match(provenance.url, /environment/);
    assert.match(provenance.apiKey, /environment/);
  });

  it('never takes the key from the config file', () => {
    writeConfigFile('config', `OMNIROUTE_CUSTOM_WEBSEARCH_URL=${FILE_URL}\nOMNIROUTE_CUSTOM_WEBSEARCH_API_KEY=sk-wrong-place\n`);
    writeConfigFile('credentials', 'OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY=sk-file\n');
    assert.equal(resolveConfig().config.omniRouteApiKey, 'sk-file');
  });

  it('takes an explicit --api-key-file, which wins over the environment', () => {
    const explicit = join(process.env.XDG_CONFIG_HOME as string, 'explicit-key');
    writeFileSync(explicit, 'OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY=sk-explicit\n', { mode: 0o600 });
    writeConfigFile('config', `OMNIROUTE_CUSTOM_WEBSEARCH_URL=${FILE_URL}\n`);
    setEnv('OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY', 'sk-env');
    const { config, provenance } = resolveConfig({ credentialsFile: explicit });
    assert.equal(config.omniRouteApiKey, 'sk-explicit');
    assert.match(provenance.apiKey, /--api-key-file/);
  });

  it('names every location searched when the URL is missing', async () => {
    await assert.rejects(
      () => loadConfig(),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /environment/);
        assert.match(error.message, /config file/);
        return true;
      }
    );
  });

  it('names every location searched when the key is missing', async () => {
    writeConfigFile('config', `OMNIROUTE_CUSTOM_WEBSEARCH_URL=${FILE_URL}\n`);
    await assert.rejects(
      () => loadConfig(),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /credentials file/);
        assert.match(error.message, /OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY/);
        return true;
      }
    );
  });
});

describe('parseKeyValueFile', () => {
  it('ignores comments and blanks, strips one layer of quotes, last assignment wins', () => {
    assert.deepEqual(
      parseKeyValueFile('# comment\n\nA=1\nB="two words"\nC=\'three\'\nA=4\n'),
      { A: '4', B: 'two words', C: 'three' }
    );
  });

  it('does not expand anything (no shell semantics)', () => {
    assert.deepEqual(parseKeyValueFile('A=$HOME/${B}\n'), { A: '$HOME/${B}' });
  });

  it('skips lines that have no key', () => {
    assert.deepEqual(parseKeyValueFile('=novalue\nnokey\n'), {});
  });
});

describe('configPaths', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('defaults to <XDG_CONFIG_HOME>/omni-websearch', () => {
    useTempConfigHome();
    const base = join(process.env.XDG_CONFIG_HOME as string, 'omni-websearch');
    assert.deepEqual(configPaths(), {
      configFile: join(base, 'config'),
      credentialsFile: join(base, 'credentials'),
    });
  });

  it('honours explicit overrides', () => {
    assert.deepEqual(configPaths({ configFile: '/a', credentialsFile: '/b' }), {
      configFile: '/a',
      credentialsFile: '/b',
    });
  });
});
