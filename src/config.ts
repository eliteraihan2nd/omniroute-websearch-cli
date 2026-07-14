export const DEFAULTS = {
    timeout: 30000,
    probeTimeout: 5000,
};

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
 * OMNIROUTE_PROVIDERS / --provider override the set; --max overrides the count.
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

export interface OmniSearchConfig {
    omniRouteUrl: string;
    omniRouteApiKey: string;
    timeout: number;
    providers?: Record<string, number>;
}

/**
 * Normalize the OMNIROUTE_PROVIDERS string[] into a weighted map.
 * First listed provider gets the highest weight; falls back to getWeightedRandom.
 */
export function normalizeProviders(
  providers: string[] | undefined
): Record<string, number> | undefined {
  if (providers === undefined || providers.length === 0) return undefined;
  const map: Record<string, number> = {};
  const n = providers.length;
  for (let i = 0; i < n; i++) {
    map[providers[i]] = n - i;
  }
  return map;
}

async function probeUrl(url: string, apiKey: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/v1/search`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response.ok || response.status === 405;
  } catch {
    clearTimeout(timeoutId);
    return false;
  }
}

export async function resolveBaseUrl(urlList: string, apiKey: string): Promise<string> {
  const urls = urlList.split(',').map(u => u.trim()).filter(Boolean);
  if (urls.length === 0) throw new Error('No base URL configured. Export OMNIROUTE_CUSTOM_WEBSEARCH_URL.');
  const results = await Promise.all(urls.map(async url => ({ url, ok: await probeUrl(url, apiKey, DEFAULTS.probeTimeout) })));
  const working = results.find(r => r.ok);
  if (working) return working.url;
  throw new Error(`No reachable OmniRoute endpoint. Tried: ${urls.join(', ')}`);
}

/**
 * Resolve the XDG config file path for this CLI.
 * `$XDG_CONFIG_HOME/omni-websearch/config`, else `~/.config/omni-websearch/config`.
 * Returns undefined if no usable base dir exists (HOME/XDG_CONFIG_HOME unset) —
 * callers must fail fast rather than guess a path.
 */
function configFilePath(): string | undefined {
  const base = process.env.XDG_CONFIG_HOME
    || (process.env.HOME ? `${process.env.HOME}/.config` : undefined);
  if (!base) return undefined;
  return `${base}/omni-websearch/config`;
}

/**
 * Parse a minimal KEY=value config file. `#` comments and blank lines are
 * ignored; values are trimmed. Returns the parsed map (may be empty).
 */
function parseConfigFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Stub config written when no config file exists yet. All values commented out
 * so it carries no secrets and fails fast until the user fills it in.
 */
const CONFIG_STUB = `# omni-websearch config — uncomment and fill, then re-run. Env vars take precedence.

OMNIROUTE_CUSTOM_WEBSEARCH_URL=https://omniroute.domain.id
OMNIROUTE_API_KEY=sk-your-key-here
# OMNIROUTE_PROVIDERS=exa-search,tavily-search,brave-search,serper-search
`;

/**
 * Load configuration.
 *
 * Precedence (env wins if both set):
 *   1. Exported environment variables (highest priority)
 *   2. XDG config file ($XDG_CONFIG_HOME/omni-websearch/config or
 *      ~/.config/omni-websearch/config) — filled only for keys not in env
 *
 * If neither source provides the required credentials, the config file is
 * created (if absent) as a commented stub, and the CLI fails fast naming the
 * file path and the two required variables. The file is written 0600 so a
 * later edit holding secrets stays owner-only.
 */
export async function loadConfig(): Promise<OmniSearchConfig> {
    const envUrl = process.env.OMNIROUTE_CUSTOM_WEBSEARCH_URL?.trim() || undefined;
    const envKey = process.env.OMNIROUTE_API_KEY?.trim() || undefined;
    const envProviders = process.env.OMNIROUTE_PROVIDERS
        ?.split(',')
        .map((p) => p.trim())
        .filter(Boolean);

    let fileUrl: string | undefined;
    let fileKey: string | undefined;
    let filePath: string | undefined;
    const path = configFilePath();
    if (path) {
        filePath = path;
        try {
            const fs = await import('node:fs');
            const parsed = parseConfigFile(fs.readFileSync(path, 'utf8'));
            fileUrl = parsed.OMNIROUTE_CUSTOM_WEBSEARCH_URL?.trim() || undefined;
            fileKey = parsed.OMNIROUTE_API_KEY?.trim() || undefined;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
    }

    const omniRouteUrl = envUrl || fileUrl;
    const omniRouteApiKey = envKey || fileKey;

    if (!omniRouteUrl || !omniRouteApiKey) {
        if (filePath) {
            let exists = false;
            try {
                const fs = await import('node:fs');
                exists = fs.existsSync(filePath);
                if (!exists) {
                    fs.mkdirSync(`${filePath.split('/').slice(0, -1).join('/')}`, { recursive: true });
                    fs.writeFileSync(filePath, CONFIG_STUB, { mode: 0o600 });
                }
            } catch {
            }
        }
        const missing: string[] = [];
        if (!omniRouteUrl) missing.push('OMNIROUTE_CUSTOM_WEBSEARCH_URL');
        if (!omniRouteApiKey) missing.push('OMNIROUTE_API_KEY');
        const where = filePath ? `\nConfig file: ${filePath}` : '';
        throw new Error(
            `Missing required configuration: ${missing.join(', ')}.${where}\n` +
            'Set them via environment variables (highest precedence) or by editing the\n' +
            'config file above (uncomment + fill the values), then re-run:\n' +
            '  export OMNIROUTE_CUSTOM_WEBSEARCH_URL="https://your-omniroute-host"\n' +
            '  export OMNIROUTE_API_KEY="sk-..."'
        );
    }

    let fileProviders: string[] | undefined;
    if (path && filePath) {
        try {
            const fs = await import('node:fs');
            const parsed = parseConfigFile(fs.readFileSync(path, 'utf8'));
            if (parsed.OMNIROUTE_PROVIDERS) {
                fileProviders = parsed.OMNIROUTE_PROVIDERS.split(',').map(p => p.trim()).filter(Boolean);
            }
        } catch {
        }
    }
    const providerList = envProviders?.length ? envProviders : fileProviders;
    const providers = providerList?.length ? normalizeProviders(providerList) : undefined;

    return { omniRouteUrl, omniRouteApiKey, timeout: DEFAULTS.timeout, providers };
}
