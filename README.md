# harness-routing

A per-turn harness router built on [Jev](https://docs.typesafe.ai/) (TypeSafe's System One model).

One call, before the real work starts, decides four things about an agent turn:

| decision | how it is asked |
| --- | --- |
| **model tier** | not asked — derived in code from turn difficulty and scope |
| **effort budget** | same, from the same `Score` |
| **tools** | one `Noul` per tool, plus the tail of a ranking `Choice` |
| **skill** | one `Choice` over the catalogue, gated by four request-shape `Noul`s |

```ts
import { createRouter, systemPromptParts } from "jev-harness-router";

const router = createRouter();
await router.prewarm();                       // once, at harness startup

const route = await router.route({ message: "arreglá el bug de auth en el login" });

route.model;   // "claude-sonnet-5"
route.effort;  // "medium"
route.tools;   // ["Read", "Grep", "Edit"]
route.skill;   // "debug" | null
route.source;  // "jev" | "cache" | "shortcut" | "fallback"
```

```bash
npm install
cp .env.example .env     # TYPESAFE_API_KEY, and a provider key for `chat`
npm run calibrate        # measure your network, write your deadline

npm run route            # decide only: type turns, watch them route
npm run chat             # decide and run: the routed turn goes to the routed model
```

Interactive mode warms the connection once instead of once per turn, which is the shape
a real harness runs in and the honest way to get a feel for the thing. Everything also
runs offline with `MOCK=1`, which answers from the local heuristic and says so.

## Measured

Against `fixtures/turns.jsonl` (54 labelled turns, 24 skills, 11 tools, 20 questions per
request), on `jev-1.13.0`, from Buenos Aires:

| | heuristic | jev | |
| --- | --- | --- | --- |
| skill exact | 81.5% | **94.4%** | +13.0pp |
| skill missed | 28.0% | **4.0%** | +24.0pp |
| skill false positive | **3.4%** | 6.9% | −3.4pp |
| tier within 1 | 92.6% | 92.6% | ±0 |
| tier too cheap | 31.5% | **1.9%** | +29.6pp |
| tier exact | **64.8%** | 53.7% | −11.1pp |
| tool recall | 61.2% | **68.6%** | +7.4pp |
| tool precision | **58.7%** | 52.1% | −6.6pp |

Read the tier rows together. The heuristic hits the exact tier more often but
under-provisions on a third of turns; the router matches it on staying within one tier
and under-provisions on 1.9%. Too big shows up on the bill. Too small shows up as a
worse answer nobody notices, which is why the estimator is deliberately biased against
it.

The tool-precision loss is partly a labelling artefact: the fixtures list only the tools
a turn strictly cannot be done without, so a defensible extra tool scores as an error.

Latency, across five benchmark runs on different days and network conditions:

```
p50                   351–376ms      barely moves
p95                   444–1006ms     moves a lot
end to end, max       470–605ms      bounded by the deadline, by construction
fell back             0–8 of 50      0% to 16%, depending on the day
cost                  4,015 input tokens per call    $0.169 per 1,000 turns
```

That spread is the honest result, and the single prettiest run is not quoted on its own
because it would be misleading. The median is stable and the tail is not, which is
precisely the condition a deadline plus a fallback is for: the router cannot make the
network reliable, but it can stop an unreliable network from reaching the turn. The
end-to-end max never exceeds the deadline, whatever the tail does.

`npm run bench` prints all of this, plus the batching ablation and the deadline curve.

## What the measurements changed

**The deadline is calibrated, not chosen.** A bare TCP connect to `api.typesafe.ai` from
Buenos Aires is 217 ms, so ~300 ms is a floor no amount of tuning moves — and from
somewhere closer it would be much lower. `npm run calibrate` measures the round trip from
wherever you are and writes the deadline that hits your target coverage into `.env`. The
shipped 600 ms is only what applies when nothing has been calibrated.

**State size is not the lever here, contrary to the usual advice.** Ten times the tokens
changed the round trip by nothing — 306 tokens took 371 ms, 3,199 took 325 ms. The docs'
"filter the state first" guidance is measured against a 54 KB document; this router's
state is already tiny, and what is left is network. Trimming questions would buy nothing,
which is why the router asks twenty of them.

**Structured skill criteria are on by default,** because the A/B came back decisive:
`what`/`not_for`/`examples` objects gave 94.4% skill accuracy against 92.6% for plain
strings, and 0% missed against 4%, at the same false-positive rate. They cost 24% more
input tokens and no measurable time. `npm run eval -- --strings` runs the comparison.

**A threshold sweep that will not peak means a question is missing.** The first eval
could only reach 90.7% skill accuracy, and only by dropping the gate to 0.10 — at which
point it barely gated. The cause was that the cookbook's three gates all ask whether an
*action* is wanted, and this catalogue carries advisory skills: writing an ADR touches
nothing and follows no command list, so `architecture` was suppressed on turns the
ranking had already named at confidence 0.99. Adding a fourth question about producing a
structured work product restored a real interior optimum (0.10 → 87.0%, **0.20 → 92.6%**,
0.30 → 90.7%, 0.40 → 79.6%) and took skill accuracy to 94.4%.

**The second hop stays off,** and now refuses to run when it would learn nothing. Only
2–4% of turns have a contested enough ranking to want one. Worse, once structured
criteria became the default for the *first* pass, a rerank was re-reading the identical
text — a round trip for nothing. Skill cards now carry a `detail` field that only the
second pass sends, and `rerankAddsEvidence()` skips the call when no finalist has one.
That is what progressive disclosure has to mean: the finalists are judged against
something the ranking never saw, or there is no point asking twice.

**A timeout must not abort the request.** This one cost the most to find. Aborting on the
deadline tears down the pooled TLS connection, and re-establishing it costs about as much
as the deadline itself — so a slow turn made the next turn slow, which timed out, which
aborted, which made the one after that slow. Live routes alternated
fallback/jev/fallback/jev indefinitely. The deadline is now enforced by a timer alone:
the abandoned request runs to completion, the socket goes back to the pool clean, and
`onLate` puts the answer that eventually arrives into the cache, so re-sending that turn
is free. Only the caller's own signal aborts, because that is a real cancellation.

**Route on the distribution, not on the expectation.** Asked how much work
"escribí el ADR de por qué elegimos Kafka sobre SQS" needs, Jev answered
`{0: 0.45, 1: 0.08, 2: 0.04, 3: 0.43}` — two readings of the turn, not one middling one.
Its expectation, 1.46, describes neither, and thresholding it sent a design task to the
cheapest model. Policy now reads the 0.60 quantile of the distribution instead, which
routes that turn to the top tier and takes under-provisioning across the fixtures from
7.4% to 1.9%. The docs say to read `score` and `probabilities` together; this is what
that looks like once you actually do it.

The same finding killed a threshold. `escalateConfidence` — escalate a tier when the
model is unsure — came from the confidence-routing pattern, which is about *Choice*
confidence, and the jaggedness page is explicit that a threshold tuned on one primitive
does not carry to another. Half these turns have a Score confidence under 0.5, so at the
pattern's 0.5 the safety net was the default path. It ships at 0, and a grid over 270
combinations confirms that is better.

**A constant computed at import is not configurable.** `DEFAULT_DEADLINE_MS` read its
environment variable at module scope, and ESM hoists every `import` above the module
body — so it was fixed before any CLI's `loadEnv()` ran, and `npm run calibrate` wrote a
value that everything then ignored. It is a function now.

## The design, in five decisions

**One request per turn.** All the questions are independent given the same state, and Jev
evaluates them in parallel. So the router asks everything it might need and lets code
throw away what does not apply. Measured on this catalogue: one call with 20 questions is
2.5x cheaper and 24x faster than 20 calls with one each.

**Never ask "which model".** The tier is a property of the difficulty, which is a property
of the turn. Asking about it directly is two hops of indirection, a documented weak spot
of `jev-1.13`. The router asks how hard the turn is and how much of the project it
touches; `policy.ts` maps that onto a model. Swapping in a new model is an edit to one
catalogue file, with no prompt changes.

**Choice and Noul answer different questions, so both are used.** A `Choice` is relative
and always names a winner. A `Noul` is absolute and can come back low for everything. On
"escribí el ADR", `tool::Write` came back at 0.33 as a Noul — will the assistant *have
to* create a file? not necessarily, an ADR can go in the reply — and at 0.79 in the
ranking Choice, because *if* any tool is involved it is obviously that one. Both are
right, and the policy refuses to let the relative one clear the absolute bar on a
write-risk tool.
Tool selection is multi-label and often empty, so every tool gets its own `Noul`; the
ranking `Choice` is read only for its runner-ups. Skills use the mirror image: the
`Choice` settles *which*, the gate `Noul`s settle *whether*. Their thresholds are tuned
separately, because one does not transfer to the other.

**The policy is pure, and the floor lives in it.** `policy.ts` is
`answers -> RouteDecision` with no I/O, so the decision layer is testable without a key
and a threshold can be moved without spending a request — `npm run eval -- --replay` does
the entire sweep offline against stored answers. It is also where safety sits: a
read-only tool is enabled at `noul ≥ 0.35`, `Bash` needs `≥ 0.8`, and the ranking tail
can promote a read-only tool but never an executing one. The message driving all this is
untrusted input, and Jev does not treat state as hostile by default.

**The deadline is the contract.** No retries, raced against the router's own timer rather
than trusting the transport to honour an abort. Past it, a deterministic heuristic
answers. That heuristic is also the baseline `npm run eval` scores against — a router
that cannot beat a page of regexes is not worth a network call.

## Where the decision goes

`prompt.ts` renders the skill choice as a block to **append after** the harness's cached
system-prompt prefix, never spliced into it:

```ts
const { cached, suffix } = systemPromptParts(rosterText, route);
// mark `cached` with your cache breakpoint, then append `suffix`
```

This is the easiest way to lose more latency than the router saves. If the roster text is
not byte-identical every turn, the downstream model's prefix cache misses, and that miss
costs far more than the ~360 ms the router spent. The wording of the block is copied from
the skill-suggestion cookbook, including the part that says the suggestion may be ignored
— pushing harder also wins compliance on the wrong suggestions, and a wrong one is worse
than none.

## Commands

```bash
npm test                 # 73 tests, no key, no network
npm run typecheck
npm run lint

npm run calibrate        # measure your network, write your deadline into .env
npm run calibrate -- --coverage 98 --dry-run

npx tsx bin/route.ts                     # interactive: type turns, see routes
npx tsx bin/route.ts "<turn>" [--rerank] [--deadline 500] [--strings] [--cold]
npm run eval                                    # accuracy vs the heuristic + sweeps
npm run eval -- --dump fixtures/answers.json    # keep the raw answers
npm run eval -- --replay fixtures/answers.json  # re-sweep offline, zero API calls
npm run eval -- --strings                       # A/B back to plain string criteria
npm run bench            # percentiles, batching ablation, deadline curve
npm run chat             # route a turn, then run it on the routed model
npm run chat -- "<turn>" # one-shot
```

Re-run the sweep on your own traffic before trusting `DEFAULT_THRESHOLDS`. Fifty-four
turns is a small sample and the labels are one person's judgement.

## Running the routed turn

`npm run route` prints a decision. `npm run chat` acts on it: the turn goes to the model
the router chose, at the effort it chose, with the skill it chose appended after the
cached prefix — and you see the reply, what it cost, and how much of the prompt the
provider served from cache.

The provider is configuration, not code. `src/catalog/provider.ts` ships Anthropic and
carries commented blocks for the rest:

```ts
export const PROVIDER = {
  kind: "openai",                          // "anthropic" | "openai"
  baseURL: "https://api.groq.com/openai",  // or omit for the vendor's own
  apiKeyEnv: "GROQ_API_KEY",               // the variable, never the key
  effortParams: (effort) => ({ reasoning_effort: effort === "low" ? "low" : "high" }),
} as const satisfies ProviderConfig;
```

Two wire formats reach almost everything. `kind: "openai"` plus a `baseURL` covers Groq,
Together, OpenRouter, DeepSeek, Mistral, vLLM, LM Studio and Ollama, because they all
speak the same chat-completions shape. Put the matching model ids in `models.ts` and
nothing else changes — the router decides a *tier*, and the catalogue decides what that
tier means.

`effortParams` is where the router's effort decision becomes vendor-specific: a thinking
budget on Anthropic, a named reasoning effort on OpenAI, nothing at all on most local
endpoints. Returning `{}` is a fine answer — the routed model still changes, which is
most of the win.

### What it deliberately does not do

**It does not execute tools.** The router decides which tools a turn should have, and
`chat` hands that decision to the model as context. Turning it into tool definitions and
an execute loop, with whatever sandboxing that needs, is the harness's job. An example
that ran model-chosen shell commands on your machine would be a bad thing to ship, and
`Bash` is in the default catalogue.

So `chat` demonstrates three of the four decisions for real — model, effort, skill — and
reports the fourth. That is the honest boundary between a router and an agent.

## Making it yours

The catalogues that ship here are one person's Claude Code setup in Spanish and English.
They are example data, not the product. **Everything that knows who you are lives in
`src/catalog/`** — no other file names a tool, a skill, a tier, or a model provider.

```bash
npm install
cp .env.example .env          # your key goes here; .env is gitignored
npm run calibrate             # measures your network, writes your deadline
```

Then edit four files. Each one is a plain `as const` object, and the types flow from it:
delete a tool and the compiler finds every reference; add a skill and
`answers["skill::which"].choice` widens to include it, with no cast anywhere.

| file | what to put there |
| --- | --- |
| `src/catalog/models.ts` | your model ids, **ordered cheapest to most capable** — the order is the ladder, and the names are yours |
| `src/catalog/tools.ts` | the tools your harness can offer, each with a risk class that sets its enable threshold |
| `src/catalog/skills.ts` | your skills, **ordered specific before general** — that order is the heuristic's precedence |
| `src/catalog/shortcuts.ts` | the bare acknowledgements in your users' language, and your command prefix |
| `src/catalog/provider.ts` | where routed turns run: provider, base URL, key variable, effort mapping |

Every card can carry `hints`: regexes used **only** by the offline heuristic, which is
both the fallback and the baseline the eval scores against. Jev never sees them — it
reads `description`. A card with no hints simply never fires there, which is a fine place
to start. Patterns are matched against diacritic-folded text, so write them unaccented:
`arregl\w*` catches "arreglá".

Skill cards can also carry `detail`, a longer paragraph sent **only on the optional
second hop**. Without it a rerank re-reads what already ranked the skill, so the router
skips the call rather than paying for it.

The prompt block is configurable too — `renderSkillBlock(route, { tag, suggest, none })`
if `<skill_relevance>` is not your convention. Keep the two properties the wording was
measured for: say the suggestion can be ignored, and say something even when nothing
applies.

### What you cannot inherit

Three things in this repo are empirical, and copying them across setups is how a router
looks good in a README and bad in production.

1. **The fixtures.** `fixtures/turns.jsonl` is 54 turns I wrote and labelled myself.
   Replace them with real turns from your own harness, labelled with the route you
   actually wanted. This is the part that takes real effort and the part that makes
   everything downstream mean anything.
2. **The thresholds.** `DEFAULT_THRESHOLDS` in `src/policy.ts` is fitted to those
   fixtures. `npm run eval` sweeps every one of them and prints the curves;
   `npm run eval -- --replay fixtures/answers.json` re-sweeps offline for free, because
   the policy is pure. Watch for a sweep with no interior peak — that means a question is
   missing, not a number (see above).
3. **The deadline.** `npm run calibrate`, and re-run it if you move or your network
   changes.

`npm run eval` compares against the heuristic every time, so if your catalogue makes the
router worse than a page of regexes on some dimension, the table says so. Believe it.

## Layout

```
src/catalog/       models, tools, skills, shortcuts — the only files that know who you are
src/state.ts       the compact object Jev evaluates, with its truncation budget
src/questions.ts   every question, pure
src/policy.ts      answers -> decision, pure
src/heuristic.ts   the fallback, and the eval baseline
src/jev.ts         the only module that talks to TypeSafe
src/router.ts      shortcut -> cache -> jev(deadline) -> policy
src/prompt.ts      the block that goes after your cached prefix
src/provider.ts    the only module that talks to the model provider
bin/calibrate.ts   measures your round trip, writes your deadline
bin/chat.ts        routes a turn, then runs it on the routed model
```

## Things worth knowing before you tune it

- **Prewarm, and note that it takes two calls.** Timed against the live API from a fresh
  process, request 1 takes ~885 ms, request 2 ~912 ms, and only from request 3 does it
  settle at ~350 ms. A single warmup left the first routed turn missing a 600 ms deadline
  in four runs out of four; two warmups gets it inside in three out of four, and the
  fourth is the tail the fallback exists for. Payload size is not the variable — warming
  with a full-sized body instead of a two-word one changed nothing. Call `prewarm()` at
  startup and drop the result.
- **Pin the model.** `.env.example` sets `jev-1.13.0`, not the `jev-latest` alias.
  Aliases move on release and these thresholds are calibrated against one version.
- **There is no server-side cache.** The `JsonCache` in the TypeSafe cookbooks is a local
  convenience for re-rendering docs. `cache.ts` is why a repeated turn is free here.
- **Context rot is still real**, even though state size is not this router's bottleneck.
  `state.ts` truncates hard and sends known facts as facts. Do not hand it the transcript.
