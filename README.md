# omniroute-websearch-cli

A lean, env-only CLI for consuming the OmniRoute web endpoints:

- `POST /v1/search` — web search
- `POST /v1/web/fetch` — extract content from a URL
- `GET /v1/search` — liveness probe + provider discovery

No config files. No runtime dependencies (Node 20+ global `fetch`/`crypto`).

## Install / run

Four ways to run it, lightest first. Only the **Installer** path yields a
true first-class executable (no bun/node at runtime); the others delegate to
bun.

### 1. One-shot, no install — `bunx github:` (zero install)

```bash
bunx github:eliteraihan2nd/omniroute-websearch-cli healthcheck
bunx github:eliteraihan2nd/omniroute-websearch-cli search "attention is all you need" --max 20
```

Clones the repo into bun's cache, builds `dist/` via `prepare`, runs the `bin`.
**Requires bun.** You always prefix with `bunx github:eliteraihan2nd/...`.

### 2. Global symlink — `bun link` (bare `omni-websearch`, needs bun + local repo)

```bash
git clone https://github.com/eliteraihan2nd/omniroute-websearch-cli.git
cd omniroute-websearch-cli
bun install && bun link
omni-websearch healthcheck          # now on PATH
```

Symlinks the `bin` into `~/.bun/bin`. Edits to the repo are live. **Requires bun.**

### 3. Standalone binary — `bun build --compile` (no bun at runtime, manual per machine)

```bash
bun install && bun run build
bun build dist/src/index.js --compile --minify --outfile omni-websearch
mv omni-websearch ~/.local/bin/      # if ~/.local/bin is on PATH
omni-websearch healthcheck
```

Produces a self-contained binary (~91 MB, bun runtime embedded). **Per-OS/arch**
— a linux-x64 binary will not run on macOS/arm64. Update = recompile + replace.

### 4. Installer — `curl | bash` (opencode-style, first-class, no bun)

```bash
curl -fsSL https://raw.githubusercontent.com/eliteraihan2nd/omniroute-websearch-cli/main/install | bash
omni-websearch healthcheck
```

The `install` script detects OS/arch, downloads the matching CI-built binary
from the latest GitHub Release, and installs it to `~/.local/bin` (respects
`XDG_BIN_DIR`). **No bun, no node, no local repo.** Binaries are built and
published automatically by GitHub Actions on each `v*` tag (see
`.github/workflows/release.yml`).

> Prebuilt binaries exist only after a `v*` tag is pushed. Until then, use
> path 1, 2, or 3.

## Credentials (required, env-only)

| Variable | Purpose | Required |
|----------|---------|----------|
| `OMNIROUTE_CUSTOM_WEBSEARCH_URL` | OmniRoute base URL | yes |
| `OMNIROUTE_API_KEY` | API key (`Authorization: Bearer`) | yes |
| `OMNIROUTE_PROVIDERS` | Comma-separated preferred providers (e.g. `tavily-search,exa-search`) | no — optional; upstream resolves selection when unset |

The CLI reads credentials **only** from environment variables. If a required
variable is missing, it fails fast naming the exact variable to export. There is
no file fallback and no hidden default.

```bash
export OMNIROUTE_CUSTOM_WEBSEARCH_URL="https://your-omniroute-host.example.com/v1"
export OMNIROUTE_API_KEY="sk-..."
export OMNIROUTE_PROVIDERS="tavily-search,exa-search,brave-search"   # optional

omni-websearch search "fp8 quantization" --max 3
```

## Commands

```
Usage: omni-websearch <command> [options]

Commands:
  search <query> [--provider <name>] [--max N]    Search web via OmniRoute
  fetch <url> [--provider <name>] [--format <f>]  Fetch/extract content from a URL
  healthcheck                                     Verify OmniRoute connectivity
  providers                                       List available OmniRoute providers
  help                                            Show this help message
```

### search

```bash
# Version (1): single provider, curated output (DEFAULT)
omni-websearch search "quantum computing"
omni-websearch search "news today" --provider exa-search
omni-websearch search "docker networking" --max 5

# Version (2): fan out to all providers, root-keyed by provider name
omni-websearch search "quantum computing" --multi

# Version (3): fan out + full upstream schema
omni-websearch search "quantum computing" --multi --all-fields

# Version (4): single provider + full upstream schema
omni-websearch search "ml papers" --all-fields --with-dates
omni-websearch search "ml papers" --include arxiv.org,github.com --exclude pinterest.com
```

Four output modes, controlled by two orthogonal flags (`--multi`, `--all-fields`):

| Mode | Flags | Output |
|------|-------|--------|
| (1) curated (DEFAULT) | — | single array, curated (title,url,snippet,position,content) |
| (2) best-effort | `--multi` | object keyed by provider: `{"tavily-search":[...],"serper-search":[...],...}`, each curated |
| (3) best-effort full | `--multi --all-fields` | same shape, full upstream schema per result |
| (4) full | `--all-fields` | single array, full upstream schema |

- `--provider <name>` — force a provider (e.g. `brave-search`, `tavily-search`, `exa-search`). Overrides `OMNIROUTE_PROVIDERS`. If unset and `OMNIROUTE_PROVIDERS` is unset, the field is omitted and **upstream resolves selection** (no hardcoded default).
- `--max N` — max results per call. When omitted, a **per-provider default** is used (tuned to each provider's quality ceiling, see below). Providers self-cap below the request. Invalid values fail fast.
- `--multi` — fan out the same query concurrently (one call per target), root-keyed by provider. Target set resolves as: `--provider` (single explicit call) → all of `OMNIROUTE_PROVIDERS` (fan out) → **one call with no provider** (upstream auto-selects). `discoverProviders` is info-only (the `providers` command) and is never used to pick/send requests. A provider error becomes that key's value (upstream error as-is), no wrapper.
- `--all-fields` — search only; return the **full** upstream schema (`provider_raw`, `citation`, `metadata`, `display_url`, `favicon_url`, `score`, `published_at`, ...). **By default output is curated**: only `title, url, snippet, position, content`. The curated default already drops OmniRoute envelope noise.
- `--with-dates` — search only; retain `published_at` in the default (curated) output (off by default — only relevant for time-sensitive/news queries; upstream formats are inconsistent, passed through verbatim).
- `--include <domains>` / `--exclude <domains>` — comma-separated domain filters.

**Per-provider default hit size** (when `--max` is omitted), chosen so one hit
demonstrates that provider's strength without degrading quality:

| Provider | default `--max` | why (strength retained up to this count) |
|----------|---------------:|------------------------------------------|
| `exa-search` | 8 | deepest extractions (~4k chars each); 8 already exceeds the others' combined text. More = bloat. |
| `tavily-search` | 10 | balanced generalist; 10 = solid breadth, readable. |
| `brave-search` | 10 | reliable baseline; trims the 16–20 long tail. |
| `serper-search` | 20 | community/forum breadth; scales to 47, so 20 keeps coverage without the dump. |
| (other/unknown) | 10 | neutral fallback. |

### fetch

```bash
omni-websearch fetch "https://example.com"                          # markdown (default)
omni-websearch fetch "https://example.com" --format html
omni-websearch fetch "https://example.com" --format links           # Exa: returns 10 links
omni-websearch fetch "https://spa.app" --selector "#app" --metadata --depth 1
```

Fetch providers are a **different namespace** from search providers, and their
behavior is **asymmetric**. The matrix below covers only the providers
**verified on this account** (`tavily-search`, `exa-search`). Others
(firecrawl, jina-reader, tinyfish) exist upstream but are not credentialed
here, so they are omitted rather than asserted.

| `--provider` | `--format` support | `--format screenshot` | `--depth` |
|--------------|-------------------|----------------------|-----------|
| `tavily-search` | **ignored** (always text) | ✓ (but ignored) | ✓ (extraction fidelity, not crawl depth) |
| `exa-search` | `markdown`,`html`,`links` only | **hard 400** | ignored |

- `--provider <name>` — `tavily-search` or `exa-search` (verified). If omitted,
  OmniRoute auto-selects the first credentialed provider; with both credentialed
  and no `--provider`, **Tavily wins and silently ignores `--format`**.
- `--format <f>` — `markdown` (default), `html`, `links`, `screenshot`. The CLI
  **fails fast** if a combo is impossible (e.g. `--provider exa-search --format
  screenshot` → local error, no round-trip). Under auto-select, `--format` may be
  ignored; a warning is printed. Use `--provider exa-search` for guaranteed format
  control.
- `--depth <n>` — `0|1|2` (default 0). Only affects Tavily. If set with a
  provider that ignores it (e.g. `exa-search`), the CLI warns and proceeds.
- `--selector <sel>` — wait for a CSS selector before extracting (provider-specific).
- `--metadata` — include page metadata in output.

Response shape (both providers): `{ provider, url, content, links[], metadata:{title,description}, screenshot_url }`.

### healthcheck

```bash
omni-websearch healthcheck
# ✓ OmniRoute is responding
```

Probes the real `GET /v1/search` route (the documented provider-listing
liveness endpoint) — not a nonexistent `/v1/health`.

### providers

```bash
omni-websearch providers
```

Lists providers discovered from OmniRoute at runtime (falls back to known
providers if the endpoint is unreachable).

## Local development

This repo ships the CLI only. For trying things locally without exporting env
vars every time, a thin dev wrapper is included:

```bash
cp .env.example .env        # then edit with your values
./omni-websearch search "fp8" --max 3
```

The `omni-websearch` script at the repo root loads `.env` (if present) and runs
the built binary with `bun`. It is **dev-only** — it is excluded from the
published package; the published `bunx`/`npx` forms remain strictly env-only.

## Build & test

```bash
npm install
npm run build        # tsc → dist/src/index.js
node --test dist/**/*.test.js
```

## License

MIT
