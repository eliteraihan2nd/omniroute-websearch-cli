/**
 * Built-in provider insights, curated from live probing (OBSERVATIONv2.md §4–5
 * for search; verified fetch contract for fetch). Surfaced by `help` as a
 * "read me" notice, suppressed with --no-notes or OMNIROUTE_NO_NOTES=1.
 *
 * Empirical observations, not upstream guarantees — OmniRoute behavior may
 * change. Search and fetch are SEPARATE provider namespaces.
 */

interface ProviderNote {
  id: string;
  role: string;
  strength: string;
  prefer: string;
}

export const SEARCH_PROVIDER_NOTES: ProviderNote[] = [
  {
    id: 'exa-search',
    role: 'SEARCH',
    strength: 'Depth — primary sources (arXiv, specs, kernel/src), extracted passages (~4000-char snippets).',
    prefer: 'When you need to UNDERSTAND a specialized term; closest to "read the paper/spec". Cap --max (e.g. 8) to avoid verbose dumps.',
  },
  {
    id: 'tavily-search',
    role: 'SEARCH',
    strength: 'Balanced general web + readable medium summaries (~990 chars); best on mainstream-technical topics.',
    prefer: 'General-purpose default — substance above brave one-liners, more concise than exa. Watch precision on rare/specialized acronyms (ZNS->Google Play, RGA->Reinsurance Group).',
  },
  {
    id: 'brave-search',
    role: 'SEARCH',
    strength: 'Reliable safe baseline — wiki / man / spec, never wrong, lowest junk risk (~320 chars).',
    prefer: 'Quick authoritative pointer; lowest-risk pick.',
  },
  {
    id: 'serper-search',
    role: 'SEARCH',
    strength: 'Community / forum / QA breadth (Reddit, SO, cs.stackexchange, Google Groups, GitHub issues); shallow snippets (~146 chars) but scales to 47 results.',
    prefer: '"What are people saying" / community + QA signal; broadest coverage when cranked (--max 30-50). Not for technical depth.',
  },
];

export const FETCH_PROVIDER_NOTES: ProviderNote[] = [
  {
    id: 'tavily-search',
    role: 'FETCH',
    strength: 'Default auto-select winner. Returns full extracted page text. depth 0|1|2 maps to extraction fidelity (basic->advanced).',
    prefer: 'General fetch of article/HTML content. IGNORES --format (always returns text) and IGNORES --selector.',
  },
  {
    id: 'exa-search',
    role: 'FETCH',
    strength: 'Honors --format: markdown, html, links (returns content + links). Ignores --depth. HARD 400 on screenshot ("Exa contents does not support screenshot format").',
    prefer: 'When you need structured output (markdown/html/links) or link extraction. NEVER pass --format screenshot.',
  },
];

function render(notes: ProviderNote[]): string {
  const lines: string[] = [];
  for (const n of notes) {
    lines.push(`  [${n.role}] ${n.id}`);
    lines.push(`    strength: ${n.strength}`);
    lines.push(`    prefer:  ${n.prefer}`);
  }
  return lines.join('\n');
}

export function formatProviderNotes(): string {
  const out: string[] = [];
  out.push('=== PROVIDER INSIGHTS (read me) — suppress with --no-notes ===');
  out.push('SEARCH providers:');
  out.push(render(SEARCH_PROVIDER_NOTES));
  out.push('  DEFAULTS ALREADY TUNED: providers set in OMNIROUTE_PROVIDERS already use their');
  out.push('  strength — per-provider --max is preset and the default output is already');
  out.push('  curated (only necessary keys). --all-fields restores the full schema.');
  out.push('  No extra tuning needed for a balanced search.');
  out.push('FETCH providers (separate namespace from search):');
  out.push(render(FETCH_PROVIDER_NOTES));
  out.push('  DEFAULT FETCH (no --provider): CLI routes to the known, tested provider that');
  out.push('  can honor your flags — --format -> exa-search, --depth -> tavily-search');
  out.push('  (both only honored there). No flag -> upstream auto-selects. Explicit');
  out.push('  --provider is always honored (and validated: exa hard-400s on screenshot).');
  out.push('(Empirical observations from live probing; OmniRoute behavior may change.)');
  return out.join('\n');
}
