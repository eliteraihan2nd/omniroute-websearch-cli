# omniroute-websearch-cli

A lean CLI for consuming the OmniRoute web endpoints:

- `POST /v1/search` — web search
- `POST /v1/web/fetch` — extract content from a URL
- `GET /v1/search` — liveness probe + provider discovery

No runtime dependencies (Node 20+ global `fetch`/`crypto`).

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
bun build dist/src/index.js --compile --minify --outfile omni-websearch-bin
install -m755 omni-websearch-bin ~/.local/bin/omni-websearch   # if ~/.local/bin is on PATH
omni-websearch healthcheck
```

Produces a self-contained binary (~91 MB, bun runtime embedded). **Per-OS/arch**
— a linux-x64 binary will not run on macOS/arm64. Update = recompile + replace.
Never write the output over `omni-websearch` — that name is the tracked dev
wrapper at the repo root, and the compile would overwrite it.

### 4. Installer — `curl | bash` (opencode-style, first-class, no bun)

```bash
curl -fsSL https://raw.githubusercontent.com/eliteraihan2nd/omniroute-websearch-cli/main/install | bash
omni-websearch healthcheck
```

The `install` script detects OS/arch, downloads the matching CI-built binary
from the latest GitHub Release, **verifies its sha256 checksum** against the
`checksums.txt` published with that release, and installs it to `~/.local/bin`
(respects `XDG_BIN_DIR`). **No bun, no node, no local repo.** Binaries and
checksums are built and published automatically by GitHub Actions on each
`v*` tag (see `.github/workflows/release.yml`).

**Update = re-run the same one-liner** — the script is idempotent and replaces
the binary in place. No separate update command needed.

**Version pin** (e.g. rollback): pass the tag as an argument or env var

```bash
curl -fsSL https://raw.githubusercontent.com/eliteraihan2nd/omniroute-websearch-cli/main/install | bash -s v0.2.0
# or
curl -fsSL https://raw.githubusercontent.com/eliteraihan2nd/omniroute-websearch-cli/main/install | INSTALL_VERSION=v0.2.0 bash
```

> Prebuilt binaries exist only after a `v*` tag is pushed. Until then, use
> path 1, 2, or 3.

## Configuration

Highest precedence first — `omni-websearch config check` prints which source won:

| Source | Holds | Location |
|---|---|---|
| flags | per-invocation overrides | `--provider`, `--max`, `--config-file`, `--api-key-file` |
| environment | anything | `OMNIROUTE_CUSTOM_WEBSEARCH_URL`, `OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY`, `OMNIROUTE_CUSTOM_WEBSEARCH_PROVIDERS` |
| config file | URL + providers — never secrets | `~/.config/omni-websearch/config` |
| credentials file | the API key | `~/.config/omni-websearch/credentials` (mode 600) |

`$XDG_CONFIG_HOME` replaces `~/.config` when set. Both files are `KEY=value` with
`#` comments, no shell expansion, last assignment wins.

The key is resolved separately: `--api-key-file` → environment → credentials file.
It is **never** read from the config file, so that file stays shareable — a key
found there is ignored with a warning. Taking the key from the environment works
but warns, because env vars leak (`ps`, logs, `docker inspect`, `systemctl show`).

The base URL is normalized: both `https://host` and `https://host/v1` work — a
trailing `/v1` is stripped once so endpoint paths are never duplicated
(`/v1/v1/...` can't happen).

### Set it up

```bash
mkdir -p ~/.config/omni-websearch
printf 'OMNIROUTE_CUSTOM_WEBSEARCH_URL=%s\n'       "https://your-omniroute-host.example.com/v1" >> ~/.config/omni-websearch/config
printf 'OMNIROUTE_CUSTOM_WEBSEARCH_PROVIDERS=%s\n' "tavily-search,exa-search,brave-search"    >> ~/.config/omni-websearch/config

install -m600 /dev/null ~/.config/omni-websearch/credentials
printf 'OMNIROUTE_CUSTOM_WEBSEARCH_API_KEY=%s\n' "$KEY" >> ~/.config/omni-websearch/credentials

omni-websearch config check                      # what resolved, and from where
omni-websearch search "fp8 quantization" --max 3
```

Environment variables still work unchanged and take precedence over the files —
useful in CI. `OMNIROUTE_CUSTOM_WEBSEARCH_PROVIDERS` is resolved client-side (a
weighted-random pick, first listed = highest weight) before the request reaches
OmniRoute; with it unset, upstream selects.

## Commands

```
Usage: omni-websearch <command> [options]

Commands:
  search <query> [--provider <name>] [--max N]    Search web via OmniRoute
  fetch <url> [--provider <name>] [--format <f>]  Fetch/extract content from a URL
  healthcheck                                     Verify OmniRoute connectivity
  providers                                       List available OmniRoute providers
  config [path|check]                             Show config paths / resolved values
  help                                            Show this help message
```

## Provider insights

Empirical observations from live probing — not upstream guarantees, and OmniRoute
behaviour may change. Search and fetch are **separate provider namespaces**.
`omni-websearch help` prints the short form; `--no-notes` suppresses it.

### Search

| Provider | Strength | Prefer it for |
|---|---|---|
| `exa-search` | Deepest extraction (~4k chars/result); primary sources (arXiv, specs, source) | Understanding a specialized term. Cap `--max` (e.g. 8) |
| `tavily-search` | Balanced web + medium summaries (~990 chars) | General-purpose default. Weakest on rare acronyms |
| `brave-search` | Safe baseline (wiki/man/spec), lowest junk risk (~320 chars) | A quick authoritative pointer |
| `serper-search` | Community/forum/QA breadth; shallow (~146 chars), scales to 47 results | "What are people saying"; `--max 30-50`. Not for depth |

Each provider's `--max` is preset to its sweet spot, and default output is already
curated (only the necessary keys). `--all-fields` restores the full upstream
schema. No extra tuning is needed for a balanced search.

### Fetch

| Provider | Behaviour | Prefer it for |
|---|---|---|
| `tavily-search` | Auto-select default; full page text; `--depth 0\|1\|2` maps to extraction fidelity | Article/HTML content. Ignores `--format` and `--selector` |
| `exa-search` | Honors `--format markdown\|html\|links`; ignores `--depth`; HTTP 400 on `screenshot` | Structured output or link extraction. Never `--format screenshot` |

`--provider` is passed through unchanged; with it unset, OmniRoute auto-selects.

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

- `--provider <name>` — force a provider (e.g. `brave-search`, `tavily-search`, `exa-search`). Always wins. If unset and `OMNIROUTE_CUSTOM_WEBSEARCH_PROVIDERS` is set, the CLI picks one of them itself — weighted-random, first listed gets the highest weight (`--multi` instead fans out over all of them). If neither is set, the field is omitted and **upstream resolves selection** (no hardcoded default).
- `--max N` — max results per call. When omitted, a **per-provider default** is used (tuned to each provider's quality ceiling, see below). Providers self-cap below the request. Invalid values fail fast.
- `--multi` — fan out the same query concurrently (one call per target), root-keyed by provider. Target set resolves as: `--provider` (single explicit call) → all of `OMNIROUTE_CUSTOM_WEBSEARCH_PROVIDERS` (fan out) → **one call with no provider** (upstream auto-selects). `discoverProviders` is info-only (the `providers` command) and is never used to pick/send requests. A provider error becomes that key's value (upstream error as-is), no wrapper.
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
# {"ok": true}
```

Probes the real `GET /v1/search` route (the documented provider-listing
liveness endpoint) — not a nonexistent `/v1/health`. Output is JSON; on
failure the CLI exits non-zero with a JSON error on stderr.

### providers

```bash
omni-websearch providers
# ["tavily-search","exa-search","brave-search","serper-search"]
```

Lists the providers discovered from OmniRoute at runtime. Output is JSON; if
discovery fails, the CLI exits non-zero — there is no silent empty-list
fallback.

## Local development

This repo ships the CLI only. For trying things locally without exporting env
vars every time, a thin dev wrapper is included:

```bash
cp .env.example .env        # then edit with your values
./omni-websearch search "fp8" --max 3
```

The `omni-websearch` script at the repo root loads `.env` (if present) and runs
the built binary with `bun`. It is **dev-only** — it is excluded from the
published package; the published `bunx`/`npx` forms use the config files and
environment variables described in Configuration above.

## Build & test

Bun is the package manager of record (`bun.lock` is committed; `package-lock.json`
is gitignored).

```bash
bun install
bun run build        # tsc → dist/src/index.js
npm test             # node --test dist/**/*.test.js
```

## License

MIT
