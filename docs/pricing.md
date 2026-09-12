# Token cost estimates

Agent Control calculates USD estimates from reported token consumption. The conversation header shows each agent's estimate beside its model and tokens. The Subagents list shows the model and estimated cost, without token counts. The agent-icon popover includes input, cache-read, cache-write and output costs in USD, plus an approximate EUR equivalent of the total with the exchange-rate source/date. Run Info keeps a compact column table with one row per model, total tokens, estimated cost and an all-model total. A second table lists each agent by its registered thread title, model, total tokens and cost. Hover, focus or tap a token total in either table to open its input, cached input, uncached input and output breakdown. The popover stays visible while hovered and closes on Escape or an outside click. Rows stay separate by agent identity even when workers share a role or model; all phases of the same agent contribute to its cumulative usage. Hover a cost cell for its category breakdown. The shared pricing source/date note appears once, below both tables.

These are **estimated token costs**, not invoices or ChatGPT subscription charges. Bundled OpenAI defaults use Standard API prices for short-context requests, verified on the date shown in Run Info. They exclude separately billed tools, Fast/Batch/Flex adjustments, long-context premiums and regional surcharges. Cumulative session tokens cannot establish whether individual requests exceeded a pricing threshold. Configure effective rates when your provider or processing tier differs; the UI does not guess the tier from an aggregate.

## Configuration

Prices load deterministically, in this order:

1. `mcp/agent-control/assets/pricing.json` bundled with the plugin.
2. `<Agent Control home>/pricing.toml` (normally `~/.agent-control/pricing.toml`).
3. `<selected run's project root>/.agents/pricing.toml`.

The project is resolved from the selected run, including when its directory is a repository subdirectory, rather than from the MCP server's working directory. Later entries override individual rate fields. The same paths and TOML format work on macOS, Windows and WSL. Existing Agent Control home overrides are respected.

All rates are **USD per million tokens**, not per token. For example, to override only an existing model's output price:

```toml
[models."gpt-6-astra"]
output_per_million = 45.0 # Example negotiated rate, not the bundled public rate.
```

The Softec alias `yoda` currently maps to **GLM 5.3 Flash** (`glm-5.3-flash`), as confirmed by the operator on 2026-09-11. Keep the execution model `yoda` and provider `softec-ai-lab`; the upstream name is a reference, not a replacement gateway model ID. Its bundled Z.ai API reference rates, verified on that date, are $0.15 uncached input, $0.03 cached input and $0.50 output per million tokens. These reference rates do not establish Softec's actual billing. The canonical GLM model name has the same bundled rates.

Z.ai lists cached-input storage as temporarily free. Storage is distinct from token writes: new cache entries retain the ordinary input token rate, without an extra write surcharge. The refresh script refuses a future paid-storage layout until its billing can be represented. To configure confirmed Softec rates, override all four values explicitly; for example, the current public reference is:

```toml
[models."yoda"]
input_per_million = 0.15
cached_input_per_million = 0.03
cache_write_input_per_million = 0.15
output_per_million = 0.50
```

Run Info identifies GLM 5.3 Flash and the Z.ai pricing reference below the model totals. The independently configured `deepseek-v4-flash-vision-exp` model retains its own DeepSeek peak reference; it no longer supplies Yoda's estimate.

A key such as `"softec-ai-lab/yoda"` takes precedence over `"yoda"` when the agent reports that provider identity. A model-only override also works for older sessions that do not report the provider. New model keys require all four fields. Anakin and other unknown aliases remain unpriced until configured. An explicit zero means free; a missing rate means unknown.

Only the `models` and optional `exchange` tables are accepted. Models accept the four numeric fields above; `exchange` accepts only `usd_per_eur`. Rates must be finite and nonnegative. Invalid overrides disable cost estimates while the rest of the dashboard remains available. Correct the file and refresh; restarting or reinstalling is unnecessary. Overrides survive plugin upgrades.

## Euro equivalents

The bundled snapshot also stores the ECB reference quote and its publication date. The popover divides the **unrounded USD amount** by the quoted dollars per euro, then formats the EUR result with two decimal places and a decimal point. It is an approximate conversion, not a provider or bank invoice rate. USD remains the accounting currency in the chat header, Subagents list and Run Info tables.

The same user/project `pricing.toml` files can override the exchange rate independently of model prices:

```toml
[exchange]
usd_per_eur = 1.16 # Example: one euro buys 1.16 dollars.
```

The value must be finite and positive. A custom quote is labeled as configured rather than attributed to the ECB. The maintainer price-update command refreshes the bundled exchange quote together with model prices; dashboard views never download exchange rates. The popover shows the quote's date so an older bundle does not imply a live conversion.

## Calculation and missing data

The conversation header shows input and output tokens, without a redundant total. An unavailable cost remains visible as `—`; its tooltip explains missing usage, missing rates, invalid configuration or unattributed mixed-model usage.

Local Codex conversations and managed CLI workers read measured cumulative usage from their native rollout, including active and interrupted turns. The read-only Codex thread index selects the current rollout after resume; filenames are a fallback and session metadata must match the exact thread identity. Legacy CLI completion journals remain supported when no native usage is available. These sources are alternatives, never added together. Remote sessions without readable usage remain unknown.

Coordinator and observer conversations are measured from the run's creation time, including when they connect later. Metering reads verified historical rollouts as well as the current file, removes copied records, and preserves the run's counts and cache partitions in SQLite. A new native file with proven fresh request counters can continue the measurement after a counter restart; unexplained resets remain unknown. A later lifetime or attachment snapshot cannot replace these run-scoped counts.

While supervised work remains pending (including child runs), the conversation meter continues. When all work settles, it stops at the recorded work completion boundary; later chat, reconnection, and event acknowledgements do not increase that run's consumption. Adding work to the same run reopens and extends its window from the original creation time. This is a metering boundary, not an irreversible run shutdown. Counts describe the thread's activity during that time window: unrelated parallel work in the same thread and overlapping runs cannot be attributed exclusively by timestamps. Run Info identifies this scope below the agent usage heading.

Other attached workers retain their registration baseline. A stored worker snapshot with newer, different totals takes precedence; native cache partitions can replace an incomplete snapshot only when its model and totals match.

When all partitions are available:

```text
ordinary_input = input_tokens - cached_input_tokens - cache_write_input_tokens
USD = (ordinary_input × input_per_million
     + cached_input_tokens × cached_input_per_million
     + cache_write_input_tokens × cache_write_input_per_million
     + output_tokens × output_per_million) / 1,000,000
```

Reasoning is already included in output and is not charged again. For older models without a cache-write surcharge, the write rate equals the ordinary input rate, not zero. If their write count is unavailable, the equally priced noncached input can still be calculated together.

Unknown prices or usage display `—`. Known categories are summed without inventing missing categories; `+` marks a partial priced subtotal. Invalid cache partitions are excluded. Costs use English formatting with exactly two decimal places, for example `$1,234.56`. Nonzero costs below one cent display `<$0.01`, preserving the distinction from free usage. Calculations and model/run aggregation retain full precision; rounding only affects presentation. Repeated snapshots are not summed, and multiple identities for the same physical thread are counted once per run. Attached worker baselines continue to exclude usage predating registration; coordinator and observer conversations use the run window described above. A mixed-model aggregate without reliable attribution remains unpriced.

Each agent is priced individually before its costs are summed by model, so provider-specific rates are not lost during grouping. Costs use the **currently configured prices**, including for historical runs; they are not immutable billing records. In particular, historical Yoda runs now use the GLM reference even if the gateway routed them to DeepSeek at the time: those records do not pin an upstream model revision. Snapshot data includes the effective per-agent rates, catalog source/date, individual reference verification dates and applied override paths for inspection.

## Refreshing bundled defaults

From the repository root:

```sh
node scripts/update-pricing.mjs
```

The script downloads the official OpenAI Standard, Z.ai and DeepSeek peak pricing tables and ECB exchange quote, validates all supported rows and atomically updates the bundled JSON snapshot. An unrecognized or missing rate leaves the previous file intact. Review the resulting diff before publication. Normal dashboard requests never access the pricing website, and this command does not modify user or project overrides.

Sources: [ECB reference exchange rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html), [Z.ai pricing](https://docs.z.ai/guides/overview/pricing), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/), [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [prompt caching and billing formula](https://developers.openai.com/api/docs/guides/prompt-caching).
