import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULTS = {
  timeout: 30000,
  probeTimeout: 5000,
} as const;

/**
 * Neutral default when no --max and no provider-specific default apply.
 * The per-provider map below is the source of truth for the default hit size.
 */
export const DEFAULT_SEARCH_MAX = 10;

/**
 * Per-provider default result counts, derived from the quality assessment
 * (OBSERVATIONv2.md). Each value is the count that retains that provider's
 * strength before quality degrades:
 *   - exa-search: 8   — deepest extractions (~4k chars each); 8 already exceeds
 *                       the other providers' combined text. More = bloat.
 *   - tavily-search: 10 — balanced generalist; 10 = solid breadth, readable.
 *   - brave-search: 10 — reliable baseline; trims the 16–20 long tail.
 *   - serper-search: 20 — community/forum breadth; scales to 47, so 20 keeps
 *                       the people-driven coverage without the 47-result dump.
 * OMNIROUTE_CUSTOM_WEBSEARCH_PROVIDERS / --provider override the set; --max overrides the count.
 * There is no hardcoded fallback provider list — upstream resolves selection.
 */
export const DEFAULT_MAX_PER_PROVIDER: Record<string, number> = {
  'exa-search': 8,
  'tavily-search': 10,
  'brave-search': 10,
  'serper-search': 20,
};

/**
 * Fetch-provider capability matrix, grounded in the OmniRoute web-fetch
 * contract (POST /v1/web/fetch) AND empirically verified on this account.
 * Fetch providers are a DIFFERENT namespace from search providers, and
 * behavior is asymmetric:
 *   - `format`: Tavily (verified) ignores it (always returns text); Exa honors
 *     markdown/html/links but HARD-400s on screenshot (verified).
 *   - `depth`: only Tavily uses it (extraction fidelity, not crawl depth,
 *     verified); Exa ignores it entirely (verified).
 *   - OmniRoute auto-selects in priority order; with no --provider and both
 *     credentialed here, Tavily wins and `format` is silently ignored.
 * Only providers actually tested on this account are listed. Others
 * (firecrawl/jina-reader/tinyfish) are credentialed-unobserved and omitted.
 * Used by runFetch to fail-fast on impossible combos (e.g. exa + screenshot)
 * and to warn where a parameter is silently ignored.
 */
export interface FetchProviderCaps {
  formats: string[];
  screenshot: boolean;
  honorsDepth: boolean;
  note?: string;
}

export const FETCH_PROVIDER_CAPS: Record<string, FetchProviderCaps> = {
  'tavily-search': { formats: ['markdown', 'html', 'links', 'screenshot'], screenshot: true, honorsDepth: true, note: 'format is ignored (always returns text); depth maps to extraction fidelity' },
  'exa-search': { formats: ['markdown', 'html', 'links'], screenshot: false, honorsDepth: false, note: 'screenshot hard-400s; depth ignored' },
};

/**
 * Configuration for the CLI, resolved from (highest precedence first):
 *   flags  >  environment variables  >  user config file
 * The API key is resolved separately and never from the config file:
 *   --api-key-file  >  environment variable (warned)  >  credentials file
 * Paths follow the XDG Base Directory spec ($XDG_CONFIG_HOME, else ~/.config).
 */
export interface OmniSearchConfig {
  /** Normalized base URL — never ends in /v1. Callers append /v1/... paths. */
  omniRouteUrl: string;
  omniRouteApiKey: string;
  timeout: number;
  providers?: Record<string, number>;
}

/** Thrown when required env config is missing or an endpoint URL is unusable. */
export class ConfigurationError extends Error {
  readonly name = 'ConfigurationError';
}

export function getWeightedRandom(providers: Record<string, number>): string | undefined {
  // Filter to enabled providers: weight must be a positive finite number
  const enabled: Array<{ name: string; weight: number }> = [];
  for (const [name, rawWeight] of Object.entries(providers)) {
    const weight = Number(rawWeight);
    // Invalid numeric (NaN, non-number) or <= 0 → disabled
    if (!Number.isFinite(weight) || weight <= 0) continue;
    enabled.push({ name, weight });
  }

  if (enabled.length === 0) return undefined;

  const totalWeight = enabled.reduce((sum, p) => sum + p.weight, 0);
  const drawNumber = Math.random();
  let cursor = drawNumber * totalWeight;

  for (const provider of enabled) {
    cursor -= provider.weight;
    if (cursor < 0) return provider.name;
  }

  // Fallback (should not reach here due to floating point)
  return enabled[enabled.length - 1].name;
}

/**
 * Normalize the OMNIROUTE_CUSTOM_WEBSEARCH_PROVIDERS string[] into a weighted map.
 * First listed provider gets the highest weight; falls back to getWeightedRandom.
 */
export function normalizeProviders(
  providers: string[] | undefined
): Record<string, number> | undefined {
  if (providers === undefined || providers.length === 0) return undefined;
  const map: Record<string, number> = {};
  for (let i = 0; i < providers.length; i++) {
    map[providers[i]] = providers.length - i;
  }
  return map;
}

/**
 * Normalize an OmniRoute base URL to host/root semantics.
 *
 * Accepts a bare host (https://omniroute.domain.id) or a host already ending
 * in /v1, and always returns the root (any trailing /v1 is stripped, trailing
 * slashes removed). Callers then append the API path themselves:
 *
 *   `new URL('/v1/search', baseUrl)`   → https://host/v1/search   (never /v1/v1)
 *   `new URL('/v1/web/fetch', baseUrl)` → https://host/v1/web/fetch
 *
 * Throws ConfigurationError for a syntactically invalid URL.
 */
export function resolveBaseUrl(rawUrl: string): string {
  const url = rawUrl.trim();
  if (url === '') throw new ConfigurationError('No base URL configured. Export OMNIROUTE_CUSTOM_WEBSEARCH_URL.');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigurationError(`Invalid OMNIROUTE_CUSTOM_WEBSEARCH_URL: "${rawUrl}". Expected an absolute URL like https://omniroute.domain.id (or .../v1).`);
  }
  let base = parsed.toString().replace(/\/+$/, '');
  if (/\/v1\/?$/i.test(base)) {
    base = base.replace(/\/v1\/?$/i, '');
  }
  return base;
}

const ENV_URL = 'OMNIROUTE_CUSTOM_WEBSEARCH_URL';
const ENV_KEY = 'OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY';
const ENV_PROVIDERS = 'OMNIROUTE_CUSTOM_WEBSEARCH_PROVIDERS';

/** Config directory, per the XDG Base Directory spec ($XDG_CONFIG_HOME, else ~/.config). */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.config'), 'omni-websearch');
}

export interface ConfigPaths {
  configFile: string;
  credentialsFile: string;
}

export function configPaths(overrides: Partial<ConfigPaths> = {}): ConfigPaths {
  const dir = configDir();
  return {
    configFile: overrides.configFile ?? join(dir, 'config'),
    credentialsFile: overrides.credentialsFile ?? join(dir, 'credentials'),
  };
}

/**
 * Parse a KEY=value file: blank lines and `#` comments ignored, one layer of
 * surrounding quotes stripped, no shell expansion, last assignment wins.
 */
export function parseKeyValueFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    if (key !== '') values[key] = value;
  }
  return values;
}

/** Absent or unreadable file → {} (the value is simply "not configured here"). */
function readFileValues(file: string): Record<string, string> {
  try {
    return parseKeyValueFile(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function envValue(key: string): string | undefined {
  const value = process.env[key];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

function warnIfLoosePermissions(file: string): void {
  try {
    const mode = statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      process.stderr.write(
        `Warning: ${file} is mode ${mode.toString(8)} — restrict it: chmod 600 ${file}\n`
      );
    }
  } catch {
    /* absent; nothing to check */
  }
}

/** Which source each value came from — surfaced by `omni-websearch config check`. */
export interface ConfigProvenance {
  url: string;
  apiKey: string;
  providers: string;
}

export interface ResolvedConfig {
  config: OmniSearchConfig;
  provenance: ConfigProvenance;
  paths: ConfigPaths;
}

export interface LoadOptions {
  configFile?: string;
  credentialsFile?: string;
}

function missingUrlMessage(paths: ConfigPaths): string {
  return [
    `Missing ${ENV_URL}. Looked in:`,
    `  environment:  ${ENV_URL}`,
    `  config file:  ${paths.configFile}`,
    'Set it in the config file:',
    `  mkdir -p ${configDir()}`,
    `  printf '${ENV_URL}=https://omniroute.example.com/v1\\n' >> ${paths.configFile}`,
  ].join('\n');
}

function missingKeyMessage(paths: ConfigPaths): string {
  return [
    `Missing ${ENV_KEY}. Looked in:`,
    `  environment:      ${ENV_KEY}`,
    `  credentials file: ${paths.credentialsFile}`,
    'Create it (mode 600):',
    `  install -m600 /dev/null ${paths.credentialsFile}`,
    `  printf '${ENV_KEY}=%s\\n' "$KEY" >> ${paths.credentialsFile}`,
  ].join('\n');
}

/**
 * Resolve configuration. Precedence:
 *   url, providers:  environment  >  config file
 *   api key:         --api-key-file  >  environment (warned)  >  credentials file
 *
 * The config file is never a source for the key — a key found there is ignored
 * with a warning, because that file is meant to be shareable/versionable.
 */
export function resolveConfig(options: LoadOptions = {}): ResolvedConfig {
  const paths = configPaths(options);
  const fileValues = readFileValues(paths.configFile);

  if (fileValues[ENV_KEY] !== undefined) {
    process.stderr.write(
      `Warning: ignoring ${ENV_KEY} in ${paths.configFile} — secrets belong in ${paths.credentialsFile} (mode 600).\n`
    );
  }

  const envUrl = envValue(ENV_URL);
  const url = envUrl ?? fileValues[ENV_URL];
  if (url === undefined) throw new ConfigurationError(missingUrlMessage(paths));

  let apiKey: string;
  let apiKeySource: string;
  const explicitFile = options.credentialsFile !== undefined;
  const envApiKey = envValue(ENV_KEY);

  if (explicitFile) {
    const fromFile = readFileValues(paths.credentialsFile)[ENV_KEY];
    if (fromFile === undefined) {
      throw new ConfigurationError(`No ${ENV_KEY} in ${paths.credentialsFile} (from --api-key-file).`);
    }
    apiKey = fromFile;
    apiKeySource = `${paths.credentialsFile} (--api-key-file)`;
    warnIfLoosePermissions(paths.credentialsFile);
  } else if (envApiKey !== undefined) {
    apiKey = envApiKey;
    apiKeySource = `environment (${ENV_KEY})`;
    process.stderr.write(
      `Warning: ${ENV_KEY} came from the environment — env vars leak via ps/logs. Prefer ${paths.credentialsFile}.\n`
    );
  } else {
    const fromFile = readFileValues(paths.credentialsFile)[ENV_KEY];
    if (fromFile === undefined) throw new ConfigurationError(missingKeyMessage(paths));
    warnIfLoosePermissions(paths.credentialsFile);
    apiKey = fromFile;
    apiKeySource = paths.credentialsFile;
  }

  const envProviders = envValue(ENV_PROVIDERS);
  const rawProviders = envProviders ?? fileValues[ENV_PROVIDERS];
  const providerList = rawProviders
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  return {
    config: {
      omniRouteUrl: resolveBaseUrl(url),
      omniRouteApiKey: apiKey,
      timeout: DEFAULTS.timeout,
      providers: providerList?.length ? normalizeProviders(providerList) : undefined,
    },
    provenance: {
      url: envUrl !== undefined ? `environment (${ENV_URL})` : paths.configFile,
      apiKey: apiKeySource,
      providers:
        envProviders !== undefined
          ? `environment (${ENV_PROVIDERS})`
          : rawProviders !== undefined
            ? paths.configFile
            : 'default (upstream selects)',
    },
    paths,
  };
}

export async function loadConfig(options: LoadOptions = {}): Promise<OmniSearchConfig> {
  return resolveConfig(options).config;
}