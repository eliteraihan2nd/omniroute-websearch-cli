/**
 * Per-provider facts surfaced by `help`. Terse on purpose: the long-form
 * explanation lives in README.md ("Provider insights"), which the notice links
 * to. Suppress the notice with --no-notes or OMNIROUTE_NO_NOTES=1.
 *
 * Empirical observations from live probing, not upstream guarantees. Search and
 * fetch are separate provider namespaces.
 */

const REPO_URL = 'https://github.com/eliteraihan2nd/omniroute-websearch-cli';

export interface ProviderNote {
  id: string;
  role: 'SEARCH' | 'FETCH';
  strength: string;
  prefer: string;
}

export const SEARCH_PROVIDER_NOTES: ProviderNote[] = [
  {
    id: 'exa-search',
    role: 'SEARCH',
    strength: 'Deepest extraction (~4k chars/result); primary sources (arXiv, specs, source).',
    prefer: 'Understanding a specialized term. Cap --max (e.g. 8).',
  },
  {
    id: 'tavily-search',
    role: 'SEARCH',
    strength: 'Balanced web + medium summaries (~990 chars).',
    prefer: 'General-purpose default. Weakest on rare acronyms.',
  },
  {
    id: 'brave-search',
    role: 'SEARCH',
    strength: 'Safe baseline (wiki/man/spec), lowest junk risk (~320 chars).',
    prefer: 'Quick authoritative pointer.',
  },
  {
    id: 'serper-search',
    role: 'SEARCH',
    strength: 'Community/forum/QA breadth; shallow (~146 chars), scales to 47 results.',
    prefer: '"What are people saying"; --max 30-50. Not for technical depth.',
  },
];

export const FETCH_PROVIDER_NOTES: ProviderNote[] = [
  {
    id: 'tavily-search',
    role: 'FETCH',
    strength: 'Auto-select default; full page text; --depth 0|1|2 maps to extraction fidelity.',
    prefer: 'Article/HTML content. Ignores --format and --selector.',
  },
  {
    id: 'exa-search',
    role: 'FETCH',
    strength: 'Honors --format markdown|html|links; ignores --depth; HTTP 400 on screenshot.',
    prefer: 'Structured output or link extraction. Never --format screenshot.',
  },
];

function render(notes: ProviderNote[]): string {
  return notes
    .map((n) => `  [${n.role}] ${n.id}\n    strength: ${n.strength}\n    prefer:  ${n.prefer}`)
    .join('\n');
}

export function formatProviderNotes(): string {
  return [
    '=== PROVIDER INSIGHTS — suppress with --no-notes ===',
    'SEARCH:',
    render(SEARCH_PROVIDER_NOTES),
    'FETCH (separate namespace from search):',
    render(FETCH_PROVIDER_NOTES),
    `Details: ${REPO_URL}#provider-insights`,
  ].join('\n');
}
