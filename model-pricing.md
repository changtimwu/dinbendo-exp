# Workers AI model choice & pricing

Snapshot date: 2026-05-17. Current model on `dinbendon.itsi.xyz`:
**`@cf/google/gemma-4-26b-a4b-it`** invoked with
`reasoning_effort: "none"` to skip the chain-of-thought. See
[`ai-perf.md`](ai-perf.md) for how we arrived here.

## Billing model

- **Free tier:** 10,000 neurons / day on both Workers Free and Workers
  Paid plans.
- **Overage rate:** $0.011 per 1,000 neurons. Available only on the
  Workers Paid plan ($5 / month minimum).
- Each model is priced per neuron; the API also displays a token-equivalent
  rate ($X / M input tokens, $Y / M output tokens) for easier comparison.

To pull the live catalog yourself:

```bash
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/models/search?task=Text%20Generation&per_page=80"
```

## Cost shape for this app

The intent-parsing prompt is about **500 input tokens + 200 output
tokens** per natural-language query (`/ask`). With reasoning suppressed
output stays small. For `@cf/google/gemma-4-26b-a4b-it`
($0.10 / M input · $0.30 / M output):

```
cost / query ≈ 500/1M * 0.10  +  200/1M * 0.30
            ≈ $0.00005 + $0.00006
            ≈ $0.00011  (~$1.10 per 10,000 queries)
```

In neuron terms that's roughly **10 neurons / query**, so the free
10K-neuron daily budget covers about **1,000 NL queries / day** before
any billing kicks in.

## Choice rationale

We landed on `@cf/google/gemma-4-26b-a4b-it` + `reasoning_effort: "none"`
after three iterations:

1. **`@cf/meta/llama-3.1-8b-instruct` (initial)** — fine quality on simple
   queries, 5-8 second responses. Acceptable but slow-feeling.
2. **`@cf/google/gemma-4-26b-a4b-it` (default config)** — picked for the
   cheap input price and tool support. Turned out to be a *reasoning*
   model that, by default, emits a long chain-of-thought before the
   JSON. End-to-end response ballooned to 10-13 seconds because
   inference time scales with output tokens.
3. **`@cf/openai/gpt-oss-20b` (interim)** — non-reasoning, ~1.5 s
   parses. Worked but with weaker geographic intuition ("Taipei 101"
   parsed as just "101") and 2× input cost.
4. **`@cf/google/gemma-4-26b-a4b-it` + `reasoning_effort: "none"`
   (current)** — same Gemma 4 model with the chain-of-thought
   suppressed via the documented `reasoning_effort` request parameter.
   Best of both: Gemma 4's good multilingual / geographic intuition,
   cheapest input on Workers AI ($0.10/M), and ~1.1-1.8 s parses.

`reasoning_effort` accepts `"none" | "low" | "medium" | "high"`; we
verified by hitting the REST endpoint directly. See
[`ai-perf.md`](ai-perf.md) for the full timing breakdown and the curl
probe that confirmed it.

For tricky parses that this combination still misses, swap up to
`@cf/openai/gpt-oss-120b` ($0.35/$0.75) or
`@cf/meta/llama-3.3-70b-instruct-fp8-fast` ($0.293/$2.253) — 2-4× more
expensive but worth it on ambiguous prompts.

## Full Workers AI text-generation catalog at a glance

### Smaller / cheaper (fine for intent parsing)

| Model | $/M input | $/M output | Context | Tools |
|---|---:|---:|---:|:---:|
| `@cf/meta/llama-3.2-1b-instruct` | 0.027 | 0.201 | 60K | — |
| `@cf/meta/llama-3.2-3b-instruct` | 0.051 | 0.335 | 80K | — |
| `@cf/mistral/mistral-7b-instruct-v0.1` | 0.110 | 0.190 | 2.8K | — |
| `@cf/meta/llama-3.1-8b-instruct-awq` | 0.123 | 0.266 | 8K | — |
| `@cf/meta/llama-3.1-8b-instruct-fp8` | 0.152 | 0.287 | 32K | — |
| `@cf/ibm-granite/granite-4.0-h-micro` | 0.017 | 0.112 | 131K | ✓ |

### Modern / mid-size, tool-capable

| Model | $/M input | $/M output | Context | Tools |
|---|---:|---:|---:|:---:|
| **`@cf/google/gemma-4-26b-a4b-it`** *(current, with `reasoning_effort:"none"`)* | **0.10** | 0.30 | 256K | ✓ |
| `@cf/qwen/qwen3-30b-a3b-fp8` | 0.051 | 0.335 | 32K | ✓ |
| `@cf/openai/gpt-oss-20b` | 0.20 | 0.30 | 128K | ✓ |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | 0.27 | 0.85 | 131K | ✓ |
| `@cf/google/gemma-3-12b-it` | 0.345 | 0.556 | 80K | — |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | 0.351 | 0.555 | 128K | ✓ |
| `@cf/zai-org/glm-4.7-flash` | 0.061 | 0.40 | 131K | ✓ |

### Bigger / smarter (for tricky parses)

| Model | $/M input | $/M output | Context | Tools |
|---|---:|---:|---:|:---:|
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 0.293 | 2.253 | 24K | ✓ |
| `@cf/openai/gpt-oss-120b` | 0.35 | 0.75 | 128K | ✓ |
| `@cf/nvidia/nemotron-3-120b-a12b` | 0.50 | 1.50 | 256K | ✓ |
| `@cf/moonshotai/kimi-k2.6` | 0.95 | 4.00 | 262K | ✓ |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | 0.497 | 4.881 | 80K | — |

### Other

| Model | $/M input | $/M output | Context |
|---|---:|---:|---:|
| `@cf/meta/llama-3.2-11b-vision-instruct` | 0.0485 | 0.676 | 128K |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | 0.66 | 1.00 | 33K |
| `@cf/qwen/qwq-32b` | 0.66 | 1.00 | 24K |
| `@cf/aisingapore/gemma-sea-lion-v4-27b-it` | 0.351 | 0.555 | 128K |
| `@cf/meta/llama-guard-3-8b` | 0.484 | 0.03 | 131K |

A handful more LoRA / older variants (Llama 2, Phi-2, Mistral v0.2-lora,
…) are available but rarely the right choice for new code.
