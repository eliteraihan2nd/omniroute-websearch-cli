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
 * OMNIROUTE_WEBSEARCH_PROVIDERS / --provider override the set; --max overrides the count.
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
 * Configuration for the CLI, read strictly from environment variables.
 * No config file is read or written.
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
 * Normalize the OMNIROUTE_WEBSEARCH_PROVIDERS string[] into a weighted map.
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
  if (url === '') throw new ConfigurationError('No base URL configured. Export OMNIROUTE_WEBSEARCH_URL.');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigurationError(`Invalid OMNIROUTE_WEBSEARCH_URL: "${rawUrl}". Expected an absolute URL like https://omniroute.domain.id (or .../v1).`);
  }
  let base = parsed.toString().replace(/\/+$/, '');
  if (/\/v1\/?$/i.test(base)) {
    base = base.replace(/\/v1\/?$/i, '');
  }
  return base;
}

/**
 * Read a required env var and fail fast (ConfigurationError) if it is
 * missing or whitespace-only. Returns the trimmed non-empty value.
 */
function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') {
    throw new ConfigurationError(
      `Missing required configuration: ${key}.\n` +
      'Set it via the environment, then re-run.'
    );
  }
  return value.trim();
}

export async function loadConfig(): Promise<OmniSearchConfig> {
    // Parse at the boundary: read env, then verify both required vars are
    // non-empty before anything else. No config file is read or written.
    const envUrl = requireEnv('OMNIROUTE_WEBSEARCH_URL');
    const envKey = requireEnv('OMNIROUTE_WEBSEARCH_API_KEY');

    const providerList = process.env.OMNIROUTE_WEBSEARCH_PROVIDERS
        ?.split(',')
        .map((p) => p.trim())
        .filter(Boolean);

    return {
        omniRouteUrl: resolveBaseUrl(envUrl),
        omniRouteApiKey: envKey,
        timeout: DEFAULTS.timeout,
        providers: providerList?.length ? normalizeProviders(providerList) : undefined,
    };
}