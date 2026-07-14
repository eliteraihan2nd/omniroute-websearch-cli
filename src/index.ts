#!/usr/bin/env node
/**
 * OmniRoute Websearch CLI
 *
 * CLI tool for accessing OmniRoute search providers.
 *
 * Usage:
 *   omni-websearch search "quantum computing" --provider tavily-search --max 8
 *   omni-websearch healthcheck
 *   omni-websearch providers
 */
import { parseArgs as parseNodeArgs } from 'node:util';
import { loadConfig, resolveBaseUrl, DEFAULT_SEARCH_MAX, DEFAULT_MAX_PER_PROVIDER, FETCH_PROVIDER_CAPS } from './config.js';
import { executeSearch, checkHealth, discoverProviders, executeFetch, curateSearchResult, SearchResult } from './search.js';
import { formatProviderNotes } from './providers-notes.js';

function getPackageVersion(): string {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path');
  // Walk up from __dirname to find package.json (covers node dist/src and
  // the compiled binary sitting next to package.json at repo root).
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'package.json');
    try {
      const version = JSON.parse(fs.readFileSync(candidate, 'utf8')).version;
      if (version) return version;
    } catch {
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'unknown';
}

/**
 * Weighted random selection from a provider map (user-configured OMNIROUTE_PROVIDERS).
 * Skips disabled providers (weight <= 0 or non-finite). Uses crypto for secure randomness.
 * Returns undefined only if no enabled providers remain.
 */
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
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  let random = (buf[0] / (0xFFFFFFFF + 1)) * totalWeight;

  for (const provider of enabled) {
    random -= provider.weight;
    if (random < 0) return provider.name;
  }

  // Fallback (should not reach here due to floating point)
  return enabled[enabled.length - 1].name;
}

interface ParsedArgs {
  command: string;
  query?: string;
  options: {
    provider?: string;
    max?: number;
    multi?: boolean;
    allFields?: boolean;
    withDates?: boolean;
    depth?: string;
    includeDomains?: string;
    excludeDomains?: string;
    format?: 'markdown' | 'html' | 'links' | 'screenshot';
    selector?: string;
    metadata?: boolean;
    noNotes?: boolean;
  };
}

export function parseArgs(args: string[]): ParsedArgs {
  // First token is the subcommand unless it starts with '--' (defaults to help).
  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'help';
  const rest = command === args[0] ? args.slice(1) : args;

  // Built-in, zero-dependency arg parser (Node >=18.3). Validates types and
  // fails fast on unknown flags (strict). Replaces a hand-rolled if/else chain.
  const { values, positionals } = parseNodeArgs({
    args: rest,
    strict: true,
    allowPositionals: true,
    options: {
      provider: { type: 'string' },
      max: { type: 'string' },
      multi: { type: 'boolean' },
      'all-fields': { type: 'boolean' },
      'with-dates': { type: 'boolean' },
      depth: { type: 'string' },
      include: { type: 'string' },
      exclude: { type: 'string' },
      format: { type: 'string' },
      selector: { type: 'string' },
      metadata: { type: 'boolean' },
      json: { type: 'boolean' },
      'no-notes': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });

  const max = values.max !== undefined ? Number(values.max) : undefined;
  if (max !== undefined && !Number.isFinite(max)) {
    throw new Error(`Invalid --max value: "${values.max}". Expected a number.`);
  }

  return {
    command,
    query: positionals[0],
    options: {
      provider: values.provider,
      max,
      multi: values.multi,
      allFields: values['all-fields'],
      withDates: values['with-dates'],
      depth: values.depth as ParsedArgs['options']['depth'],
      includeDomains: values.include,
      excludeDomains: values.exclude,
      format: values.format as ParsedArgs['options']['format'],
      selector: values.selector,
      metadata: values.metadata,
      noNotes: values['no-notes'],
    },
  };
}

function printUsage(showNotes: boolean = true) {
  console.log(`
Usage: omni-websearch <command> [options]

Commands:
  search <query> [--provider <name>] [--max N]   Search web via OmniRoute
  fetch <url> [--provider <name>] [--format <f>]  Fetch/extract content from a URL
  healthcheck                                    Verify OmniRoute connectivity
  providers                                      List available OmniRoute providers
  help                                           Show this help message

Options:
  --provider <name>  Specify search/fetch provider (e.g., tavily-search, exa-search)
  --max N            Maximum results per call (default: 20; providers self-cap)
  --multi            Fan out to all providers (OMNIROUTE_PROVIDERS or 4 defaults),
                     each as a root key: {"tavily-search":[...], ...}
  --all-fields       Search only: return the FULL upstream schema
                     (provider_raw/citation/metadata/display_url/favicon_url/score/...).
                     DEFAULT is curated: title,url,snippet,position,content only.
  --with-dates       Search only: retain published_at in the default (curated) output
                     (off by default; only relevant for time-sensitive/news queries)
  --depth <n>        Fetch depth only: 0|1|2 (search uses OmniRoute default)
  --format <f>       Fetch output format: markdown (default), html, links, screenshot
  --selector <sel>   Fetch: wait for CSS selector before extracting
  --metadata         Fetch: include page metadata in output
  --no-notes         Suppress the built-in provider insights notice
  --include <domains>    Comma-separated domains to include (e.g., 'wikipedia.org,arxiv.org')
  --exclude <domains>    Comma-separated domains to exclude
  --json                 Print raw result object (machine-readable)

Config (env vars win over the config file):
  OMNIROUTE_CUSTOM_WEBSEARCH_URL  OmniRoute base URL (required)
  OMNIROUTE_API_KEY               API key (required)
  OMNIROUTE_PROVIDERS             Comma-separated providers (optional)
  Config file (if env unset): $XDG_CONFIG_HOME/omni-websearch/config
  or ~/.config/omni-websearch/config  (created as a commented stub on first run)
  `);

  if (showNotes && !process.env.OMNIROUTE_NO_NOTES) {
    console.log(formatProviderNotes());
  }
}

async function runSearch(query: string, options: ParsedArgs['options']) {
  const config = await loadConfig();
  if (!config.omniRouteUrl || !config.omniRouteApiKey) {
    throw new Error('Configuration error: OmniRoute URL and API key must be set.');
  }
  const baseUrl = await resolveBaseUrl(config.omniRouteUrl, config.omniRouteApiKey);
  if (!baseUrl) {
    throw new Error('Error: No OmniRoute URL configured or reachable.');
  }

  const curate = (r: SearchResult) => (options.allFields ? r : curateSearchResult(r, !!options.withDates));

  // Per-provider default hit size (quality assessment in OBSERVATIONv2.md),
  // overridden by an explicit --max. Neutral fallback if provider is unknown.
  const perProviderMax = (provider: string | undefined) =>
    options.max ?? (provider && provider in DEFAULT_MAX_PER_PROVIDER
      ? DEFAULT_MAX_PER_PROVIDER[provider]
      : DEFAULT_SEARCH_MAX);

  // --multi: fan out the same query concurrently, one call per target provider.
  // Upstream always auto-handles search-provider selection; discoverProviders()
  // is INFO ONLY (surfaced via the `providers` command) and is NEVER reused to
  // pick/send requests here. Target set resolution:
  //   --provider        → single explicit call (always wins, sent directly)
  //   OMNIROUTE_PROVIDERS → fan out over all of them (request focus only)
  //   neither           → ONE call with NO provider (upstream selects)
  // Root keys are taken from the UPSTREAM response, not our request — upstream
  // may resolve/fallback a requested name to a different one, so results merge
  // under the real upstream key. Per-provider error → that key's value as-is.
  if (options.multi) {
    // ONE call per target. With neither --provider nor OMNIROUTE_PROVIDERS, the
    // single target is `undefined` -> one request with no provider field
    // (upstream selects). Empty array would skip the call entirely (wrong).
    const targets: (string | undefined)[] = options.provider
      ? [options.provider]
      : (config.providers ? Object.keys(config.providers) : [undefined]);

    const perProvider = await Promise.all(
      targets.map(async (provider) => {
        try {
          const results = await executeSearch(
            query,
            provider || undefined,
            perProviderMax(provider || undefined),
            baseUrl,
            config.omniRouteApiKey,
            config.timeout,
            options.includeDomains,
            options.excludeDomains
          );
          return { provider: provider || 'upstream', results: results.map(curate) } as const;
        } catch (error) {
          return { provider: provider || 'upstream', results: error instanceof Error ? error.message : String(error) } as const;
        }
      })
    );

    const grouped: Record<string, unknown[]> = {};
    for (const { provider, results } of perProvider) {
      if (typeof results === 'string') {
        grouped[provider] = [results]; // upstream error string as-is
      } else {
        grouped[provider] = (grouped[provider] ?? []).concat(results);
      }
    }
    console.log(JSON.stringify(grouped, null, 2));
    return;
  }

  // Single search (default). Upstream always auto-handles provider selection.
  //   --provider        → explicit win, sent directly (never consults OMNIROUTE_PROVIDERS)
  //   OMNIROUTE_PROVIDERS → weight-randomized request focus (upstream still selects)
  //   neither           → omit the field; upstream selects
  const requestProvider = options.provider
    ?? (config.providers ? getWeightedRandom(config.providers) : undefined);

  const searchResult = await executeSearch(
    query,
    requestProvider,
    perProviderMax(requestProvider),
    baseUrl,
    config.omniRouteApiKey,
    config.timeout,
    options.includeDomains,
    options.excludeDomains
  );
  console.log(JSON.stringify(searchResult.map(curate), null, 2));
}

async function runFetch(url: string, options: ParsedArgs['options']) {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('Error: A valid http/https URL is required (omni-websearch fetch <url>).');
  }
  const config = await loadConfig();
  if (!config.omniRouteUrl || !config.omniRouteApiKey) {
    throw new Error('Configuration error: OmniRoute URL and API key must be set.');
  }
  const baseUrl = await resolveBaseUrl(config.omniRouteUrl, config.omniRouteApiKey);
  if (!baseUrl) {
    throw new Error('Error: No OmniRoute URL configured or reachable.');
  }

  const depth = options.depth !== undefined ? (Number(options.depth) as 0 | 1 | 2) : undefined;

  // Without an explicit --provider, route a param-bearing fetch to the known,
  // tested provider that can honor it, so the flag is never silently dropped.
  let provider = options.provider;
  if (!provider) {
    if (options.format) { provider = 'exa-search'; process.stderr.write('Routed to exa-search (--format is only honored by exa).\n'); }
    else if (depth !== undefined) { provider = 'tavily-search'; process.stderr.write('Routed to tavily-search (--depth is only honored by tavily).\n'); }
  }

  // Fetch-provider-specific validation (grounded in the OmniRoute web-fetch
  // contract). Fail fast on impossible combos; warn where a param is silently
  // ignored upstream, so the user is never surprised by a 400 or dropped flag.
  const caps = provider ? FETCH_PROVIDER_CAPS[provider] : undefined;
  if (provider && !caps) {
    throw new Error(`Unknown fetch provider: "${provider}". Known: ${Object.keys(FETCH_PROVIDER_CAPS).join(', ')}`);
  }
  if (caps && options.format && !caps.formats.includes(options.format)) {
    throw new Error(`--format "${options.format}" is not supported by --provider ${provider} (supported: ${caps.formats.join(', ')}).`);
  }
  if (caps && depth !== undefined && !caps.honorsDepth) {
    process.stderr.write(`Warning: --provider ${provider} ignores --depth (upstream drops it). Request proceeds.\n`);
  }

  try {
    const result = await executeFetch(
      url,
      baseUrl,
      config.omniRouteApiKey,
      {
        provider: provider,
        format: options.format,
        depth,
        waitForSelector: options.selector,
        includeMetadata: options.metadata,
      },
      config.timeout
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    // Re-throw upstream error verbatim (already formatted in search.ts).
    throw error;
  }
}

async function runHealthcheck() {
  const config = await loadConfig();
  if (!config.omniRouteUrl || !config.omniRouteApiKey) {
    throw new Error('Configuration error: OmniRoute URL and API key must be set.');
  }
  const baseUrl = await resolveBaseUrl(config.omniRouteUrl, config.omniRouteApiKey);
  if (!baseUrl) {
    throw new Error('Error: No OmniRoute URL configured or reachable.');
  }
  const { omniRouteApiKey } = config;

  try {
    if (await checkHealth(baseUrl, omniRouteApiKey)) {
      console.log('✓ OmniRoute is responding');
    } else {
      console.error('✗ OmniRoute is not responding');
    }
  } catch (error) {
    console.error('✗ Health check failed:', error instanceof Error ? error.message : error);
  }
}

async function runProviders() {
  const config = await loadConfig();
  if (!config.omniRouteUrl || !config.omniRouteApiKey) {
    throw new Error('Configuration error: OmniRoute URL and API key must be set.');
  }
  const baseUrl = await resolveBaseUrl(config.omniRouteUrl, config.omniRouteApiKey);

  try {
    const providers = await discoverProviders(baseUrl, config.omniRouteApiKey);
    console.log('Available search providers:');
    for (const p of providers) {
      console.log(`  - ${p}`);
    }
  } catch (error) {
    throw new Error(`Failed to discover providers: ${error instanceof Error ? error.message : error}`);
  }
}

export async function runCli(argv: string[]) {
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(getPackageVersion());
    return;
  }

  const parsed = parseArgs(argv);

  switch (parsed.command) {
    case 'search':
      if (!parsed.query) {
        throw new Error('Error: No search query provided');
      }
      await runSearch(parsed.query, parsed.options);
      break;
    case 'fetch':
      if (!parsed.query) {
        throw new Error('Error: No URL provided');
      }
      await runFetch(parsed.query, parsed.options);
      break;
    case 'healthcheck':
      await runHealthcheck();
      break;
    case 'providers':
      await runProviders();
      break;
    case 'help':
      printUsage(!parsed.options.noNotes);
      break;
    default:
      throw new Error(`Unknown command: ${parsed.command}`);
  }
}

async function main() {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error('Fatal error:', error instanceof Error ? error.message : String(error));
    printUsage();
    process.exit(1);
  }
}

main();
