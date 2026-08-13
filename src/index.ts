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
import { loadConfig, resolveBaseUrl, getWeightedRandom, DEFAULT_SEARCH_MAX, DEFAULT_MAX_PER_PROVIDER } from './config.js';
import { executeSearch, checkHealth, discoverProviders, executeFetch, curateSearchResult, type SearchResult } from './search.js';
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
    /** Internal/test only: deterministic draw for getWeightedRandom. */
    seed?: number;
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
      seed: { type: 'string' },
      help: { type: 'boolean' },
    },
  });

  const max = values.max !== undefined ? Number(values.max) : undefined;
  if (max !== undefined && (!Number.isFinite(max) || !Number.isInteger(max) || max <= 0)) {
    throw new Error(`Invalid --max value: "${values.max}". Expected a positive integer.`);
  }

  const seed = values.seed !== undefined ? Number(values.seed) : undefined;
  if (seed !== undefined && !Number.isFinite(seed)) {
    throw new Error(`Invalid --seed value: "${values.seed}". Expected a finite number.`);
  }

  const depth = values.depth;
  if (depth !== undefined && depth !== '0' && depth !== '1' && depth !== '2') {
    throw new Error(`Invalid --depth value: "${depth}". Expected 0, 1, or 2.`);
  }

  const format = values.format;
  if (format !== undefined && !['markdown', 'html', 'links', 'screenshot'].includes(format)) {
    throw new Error(`Invalid --format value: "${format}". Expected markdown, html, links, or screenshot.`);
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
      depth: values.depth,
      includeDomains: values.include,
      excludeDomains: values.exclude,
      format: format as ParsedArgs['options']['format'],
      selector: values.selector,
      metadata: values.metadata,
      noNotes: values['no-notes'],
      seed,
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
  --multi            Fan out to all providers (OMNIROUTE_WEBSEARCH_PROVIDERS or 4 defaults),
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

Config (environment variables only):
  OMNIROUTE_WEBSEARCH_URL  OmniRoute base URL (required)
  OMNIROUTE_WEBSEARCH_API_KEY               API key (required)
  OMNIROUTE_WEBSEARCH_PROVIDERS             Comma-separated providers (optional)
  `);

  if (showNotes && !process.env.OMNIROUTE_NO_NOTES) {
    console.log(formatProviderNotes());
  }
}

type MultiOutcome =
  | { readonly ok: true; readonly results: readonly unknown[] }
  | { readonly ok: false; readonly error: string };

async function runSearch(query: string, options: ParsedArgs['options']): Promise<number> {
  const config = await loadConfig();
  if (!config.omniRouteUrl || !config.omniRouteApiKey) {
    throw new Error('Configuration error: OmniRoute URL and API key must be set.');
  }
  const baseUrl = resolveBaseUrl(config.omniRouteUrl);
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
  // OmniRoute handles provider selection/fallback. Target set resolution:
  //   --provider        → single explicit call (always wins, sent directly)
  //   OMNIROUTE_WEBSEARCH_PROVIDERS → fan out over all of them
  //   neither           → ONE call with NO provider (OmniRoute selects)
  // Each key holds { ok: true, results } or { ok: false, error }; the exit
  // code is non-zero only when every provider call fails.
  if (options.multi) {
    // ONE call per target. With neither --provider nor OMNIROUTE_WEBSEARCH_PROVIDERS, the
    // single target is `undefined` -> one request with no provider field
    // (OmniRoute selects). Empty array would skip the call entirely (wrong).
    const targets: (string | undefined)[] = options.provider
      ? [options.provider]
      : (config.providers ? Object.keys(config.providers) : [undefined]);

    const perProvider = await Promise.all(
      targets.map(async (provider) => {
        const key = provider || 'upstream';
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
          return { key, outcome: { ok: true, results: results.map(curate) } } as const;
        } catch (error) {
          return { key, outcome: { ok: false, error: error instanceof Error ? error.message : String(error) } } as const;
        }
      })
    );

    const grouped: Record<string, MultiOutcome> = {};
    for (const { key, outcome } of perProvider) {
      grouped[key] = outcome;
    }
    console.log(JSON.stringify(grouped, null, 2));
    return perProvider.every(({ outcome }) => !outcome.ok) ? 1 : 0;
  }

  // Single search (default). Provider resolution, client-side:
  //   --provider               → explicit request focus (always wins)
  //   OMNIROUTE_WEBSEARCH_PROVIDERS      → weighted-random pick (first listed = highest
  //                              weight; enabled set filtered by weight > 0)
  //   neither                  → omit the field; OmniRoute selects
  // A --seed makes the draw deterministic (test-only knob).
  const seededRandom = () => {
    let h = 2166136261 ^ (options.seed ?? 0);
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 0x100000000;
  };
  const requestProvider =
    options.provider ?? (config.providers ? getWeightedRandom(config.providers, options.seed !== undefined ? seededRandom : undefined) : undefined);

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
  return 0;
}

async function runFetch(url: string, options: ParsedArgs['options']): Promise<void> {
  // Parse the URL so only http/https targets reach OmniRoute.
  let urlIsValid = false;
  try {
    const parsed = new URL(url);
    urlIsValid = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  if (!urlIsValid) {
    throw new Error('Error: A valid http/https URL is required (omni-websearch fetch <url>).');
  }
  const config = await loadConfig();
  if (!config.omniRouteUrl || !config.omniRouteApiKey) {
    throw new Error('Configuration error: OmniRoute URL and API key must be set.');
  }
  const baseUrl = resolveBaseUrl(config.omniRouteUrl);
  if (!baseUrl) {
    throw new Error('Error: No OmniRoute URL configured or reachable.');
  }

  // Provider selection is left to OmniRoute; --provider is passed through as-is.
  const result = await executeFetch(
    url,
    baseUrl,
    config.omniRouteApiKey,
    {
      provider: options.provider,
      format: options.format,
      depth: options.depth !== undefined ? (Number(options.depth) as 0 | 1 | 2) : undefined,
      waitForSelector: options.selector,
      includeMetadata: options.metadata,
    },
    config.timeout
  );
  console.log(JSON.stringify(result, null, 2));
}

async function runHealthcheck(): Promise<void> {
  const config = await loadConfig();
  if (!config.omniRouteUrl || !config.omniRouteApiKey) {
    throw new Error('Configuration error: OmniRoute URL and API key must be set.');
  }
  const baseUrl = resolveBaseUrl(config.omniRouteUrl);
  if (!baseUrl) {
    throw new Error('Error: No OmniRoute URL configured or reachable.');
  }

  if (!(await checkHealth(baseUrl, config.omniRouteApiKey))) {
    throw new Error('OmniRoute is not responding');
  }
  console.log(JSON.stringify({ ok: true }));
}

async function runProviders(): Promise<void> {
  const config = await loadConfig();
  if (!config.omniRouteUrl || !config.omniRouteApiKey) {
    throw new Error('Configuration error: OmniRoute URL and API key must be set.');
  }
  const baseUrl = resolveBaseUrl(config.omniRouteUrl);

  let providers: string[];
  try {
    providers = await discoverProviders(baseUrl, config.omniRouteApiKey);
  } catch (error) {
    throw new Error(`Failed to discover providers: ${error instanceof Error ? error.message : error}`);
  }
  console.log(JSON.stringify(providers, null, 2));
}

export async function runCli(argv: string[]): Promise<number> {
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(getPackageVersion());
    return 0;
  }

  const parsed = parseArgs(argv);

  switch (parsed.command) {
    case 'search':
      if (!parsed.query) {
        throw new Error('Error: No search query provided');
      }
      return await runSearch(parsed.query, parsed.options);
    case 'fetch':
      if (!parsed.query) {
        throw new Error('Error: No URL provided');
      }
      await runFetch(parsed.query, parsed.options);
      return 0;
    case 'healthcheck':
      await runHealthcheck();
      return 0;
    case 'providers':
      await runProviders();
      return 0;
    case 'help':
      printUsage(!parsed.options.noNotes);
      return 0;
    default:
      throw new Error(`Unknown command: ${parsed.command}`);
  }
}

async function main() {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.stderr.write('\n');
    process.exitCode = 1;
  }
}

main();
