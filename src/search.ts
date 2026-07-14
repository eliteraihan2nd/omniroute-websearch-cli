/**
 * OmniRoute Search API Client
 *
 * Provides access to search providers via OmniRoute.
 * Providers are discovered at runtime from OmniRoute.
 */
export interface SearchResult {
  title: string;
  url: string;
  display_url?: string;
  snippet: string;
  content?: string;
  position?: number;
  score?: number;
  published_at?: string;
  favicon_url?: string;
  metadata?: {
    author?: string;
    language?: string;
    source_type?: string;
    image_url?: string;
  };
  citation?: {
    provider: string;
    retrieved_at: string;
    rank: number;
  };
}

export interface SearchResponse {
  id: string;
  provider: string;
  query: string;
  results: SearchResult[];
}

/**
 * Extract only consumer-relevant fields from a normalized SearchResult.
 * Drops OmniRoute envelope noise (provider_raw, citation, metadata,
 * display_url, favicon_url, score). `published_at` is dropped unless
 * `withDates` is true, since it is only relevant for time-sensitive
 * (news) queries and arrives in inconsistent formats across providers.
 */
export function curateSearchResult(result: SearchResult, withDates: boolean): Record<string, unknown> {
  const curated: Record<string, unknown> = {
    title: result.title,
    url: result.url,
    snippet: result.snippet,
    position: result.position,
    content: result.content,
  };
  if (withDates && result.published_at !== undefined) {
    curated.published_at = result.published_at;
  }
  return curated;
}

export interface FetchRequestOptions {
  provider?: string;
  format?: 'markdown' | 'html' | 'links' | 'screenshot';
  depth?: 0 | 1 | 2;
  waitForSelector?: string;
  includeMetadata?: boolean;
}

export interface FetchResponse {
  provider: string;
  url: string;
  content: string;
  links?: string[];
  metadata?: Record<string, unknown>;
  screenshot_url?: string;
}

interface ProviderListResponse {
  data: Array<{ id: string }>;
}

/**
 * Execute a search query via OmniRoute
 */
export async function executeSearch(
  query: string,
  provider: string | undefined,
  maxResults: number,
  baseUrl: string,
  apiKey: string,
  timeout?: number,
  includeDomains?: string,
  excludeDomains?: string,
  searchType: 'web' | 'news' = 'web'
): Promise<SearchResult[]> {
  const url = new URL('/v1/search', baseUrl);

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout || 60000);

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        ...(provider && { provider }),
        max_results: maxResults,
        search_type: searchType,
        ...(includeDomains && { include_domains: includeDomains.split(',') }),
        ...(excludeDomains && { exclude_domains: excludeDomains.split(',') }),
      }),
      signal: controller.signal,
    });
    clearTimeout(id);

    if (!response.ok) {
      const errorText = await response.text();
      // Forward the upstream error as-is: status line + raw body, no wrapping.
      throw new Error(`${response.status} ${response.statusText}\n${errorText}`);
    }

    const data = await response.json() as SearchResponse | SearchResult[];
    if (Array.isArray(data)) return data;
    return data.results;
  } catch (error) {
    clearTimeout(id);
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error(`Search request timed out after ${timeout || 60000}ms`);
      }
      throw error;
    }
    throw new Error('Unknown error during search request');
  }
}

export async function checkHealth(
  baseUrl: string,
  apiKey: string,
): Promise<boolean> {
  // OmniRoute exposes no /v1/health route. Use GET /v1/search (the provider
  // listing endpoint) as a liveness probe — it returns 200 when reachable and
  // requires no search cost.
  const url = new URL('/v1/search', baseUrl);
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });
  return response.ok;
}

export async function discoverProviders(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  try {
    const url = new URL('/v1/search', baseUrl);
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (response.ok) {
      const data = await response.json() as ProviderListResponse;
      if (data.data && Array.isArray(data.data)) {
        return data.data.map(p => p.id);
      }
    }
  } catch {
    // No providers discovered — return empty; OmniRoute handles selection.
  }

  return [];
}

/**
 * Execute a web-fetch request via OmniRoute (POST /v1/web/fetch).
 * Fetch providers differ from search providers; if no provider is given the
 * OmniRoute server auto-selects one it has credentials for.
 */
export async function executeFetch(
  targetUrl: string,
  baseUrl: string,
  apiKey: string,
  options: FetchRequestOptions = {},
  timeout?: number,
): Promise<FetchResponse> {
  const url = new URL('/v1/web/fetch', baseUrl);

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout || 60000);

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: targetUrl,
        ...(options.provider && { provider: options.provider }),
        ...(options.format && { format: options.format }),
        ...(options.depth !== undefined && { depth: options.depth }),
        ...(options.waitForSelector && { wait_for_selector: options.waitForSelector }),
        ...(options.includeMetadata && { include_metadata: options.includeMetadata }),
      }),
      signal: controller.signal,
    });
    clearTimeout(id);

    if (!response.ok) {
      const errorText = await response.text();
      // Forward the upstream error as-is: status line + raw body, no wrapping.
      throw new Error(`${response.status} ${response.statusText}\n${errorText}`);
    }

    return (await response.json()) as FetchResponse;
  } catch (error) {
    clearTimeout(id);
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error(`Fetch request timed out after ${timeout || 60000}ms`);
      }
      throw error;
    }
    throw new Error('Unknown error during fetch request');
  }
}
