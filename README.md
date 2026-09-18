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
cp .env.example .env     # then put your key in it
npx tsx bin/route.ts "arreglá el bug de auth en el login"
```

Everything runs offline with `MOCK=1`, which answers from the local heuristic and says so.

## Measured

Against `fixtures/turns.jsonl` (54 labelled turns, 24 skills, 11 tools, 20 questions per
request), on `jev-1.13.0`, from Buenos Aires:

| | heuristic | jev | |
| --- | --- | --- | --- |
| skill exact | 81.5% | **94.4%** | +13.0pp |
| skill missed | 28.0% | **0.0%** | +28.0pp |
| skill false positive | **3.4%** | 6.9% | −3.4pp |
| tier within 1 | 92.6% | **96.3%** | +3.7pp |
| tier too cheap | 31.5% | **9.3%** | +22.2pp |
| tier exact | **64.8%** | 51.9% | −13.0pp |
| tool recall | 61.2% | **67.3%** | +6.1pp |
| tool precision | **58.7%** | 51.3% | −7.4pp |

Read the tier rows together. The heuristic hits the exact tier more often but
under-provisions on a third of turns; the router is within one tier 94% of the time and
under-provisions on 9%. Too big shows up on the bill. Too small shows up as a worse
answer nobody notices.

The tool-precision loss is partly a labelling artefact: the fixtures list only the tools
a turn strictly cannot be done without, so a defensible extra tool scores as an error.

```
jev round trip        p50 351ms   p95 444ms   p99 657ms       (150 samples, warmed)
end to end            p50 347ms   p95 450ms   max 470ms       fell back 0/50
cost                  4,015 input tokens per call             $0.169 per 1,000 turns
```

98% of calls land inside the 600 ms deadline. The remaining tail is long enough to matter
— an unwarmed process sees p99 over a second — which is why the deadline exists rather
than being something to tune away.

`npm run bench` prints all of this, plus the batching ablation and the deadline curve.

## What the measurements changed

**The deadline is 600 ms, not the 400 ms this was designed with.** A bare TCP connect to
`api.typesafe.ai` from here is 217 ms, so ~300 ms is a floor no amount of tuning moves.
At 400 ms, 24–39% of turns fell back to the heuristic; at 600 ms it is 2%.

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

**The second hop stays off.** Only 2% of turns have a skill ranking contested enough to
want one. `--rerank` gates it on the top-two margin and on whatever is left of the
deadline.

**A timeout must not abort the request.** This one cost the most to find. Aborting on the
deadline tears down the pooled TLS connection, and re-establishing it costs about as much
as the deadline itself — so a slow turn made the next turn slow, which timed out, which
aborted, which made the one after that slow. Live routes alternated
fallback/jev/fallback/jev indefinitely. The deadline is now enforced by a timer alone:
the abandoned request runs to completion, the socket goes back to the pool clean, and
`onLate` puts the answer that eventually arrives into the cache, so re-sending that turn
is free. Only the caller's own signal aborts, because that is a real cancellation.

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
and always names a winner. A `Noul` is absolute and can come back low for everything.
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

npx tsx bin/route.ts "<turn>" [--rerank] [--deadline 600] [--strings]
npm run eval                                    # accuracy vs the heuristic + sweeps
npm run eval -- --dump fixtures/answers.json    # keep the raw answers
npm run eval -- --replay fixtures/answers.json  # re-sweep offline, zero API calls
npm run eval -- --strings                       # A/B back to plain string criteria
npm run bench            # percentiles, batching ablation, deadline curve
```

Re-run the sweep on your own traffic before trusting `DEFAULT_THRESHOLDS`. Fifty-four
turns is a small sample and the labels are one person's judgement.

## Making it yours

The catalogues that ship here are one person's Claude Code setup. They are example data,
not the product — the product is everything around them. Three files to edit, and nothing
else has to change:

| file | what to put there |
| --- | --- |
| `src/catalog/models.ts` | your model ids, ordered cheapest to most capable |
| `src/catalog/tools.ts` | the tools your harness can offer, with a risk class each |
| `src/catalog/skills.ts` | your skills, one line of description each |

They are plain `as const` objects, and the types flow from them. Delete a tool and the
compiler finds every place that referenced it; add a skill and
`answers["skill::which"].choice` widens to include it, with no cast anywhere. That is the
one thing you get for free.

Everything else you have to earn back by measuring:

1. **Replace `fixtures/turns.jsonl`** with 50+ real turns from your own harness, labelled
   with the route you would have wanted. This is the part that actually takes effort, and
   it is the part that makes the rest meaningful.
2. **Re-tune the thresholds.** `npm run eval` sweeps them and prints the curves.
   `DEFAULT_THRESHOLDS` in `src/policy.ts` holds values fitted to *these* fixtures on
   *this* network; they are a starting point for you, not an answer.
3. **Update the heuristic** in `src/heuristic.ts`. Its keyword patterns name specific
   skills from the example catalogue and are written for Spanish and English. It is both
   the fallback and the baseline the eval scores against, so a stale one makes the router
   look better than it is.
4. **Re-measure the deadline.** `DEFAULT_DEADLINE_MS` is 600 because a TCP connect to the
   API is 217 ms from Buenos Aires. From somewhere closer, 400 ms may be plenty.
   `npm run bench` prints the coverage curve to read it off.

A generic, catalogue-parameterised version would remove step 1's coupling to this repo's
shape. It is not built: the `as const` catalogues are what give the end-to-end typing its
teeth, and making them a type parameter costs that clarity for a benefit only a second
user gets.

## Layout

```
src/catalog/       models, tools, skills — `as const`, so answer types derive from them
src/state.ts       the compact object Jev evaluates, with its truncation budget
src/questions.ts   every question, pure
src/policy.ts      answers -> decision, pure
src/heuristic.ts   the fallback, and the eval baseline
src/jev.ts         the only module that talks to TypeSafe
src/router.ts      shortcut -> cache -> jev(deadline) -> policy
src/prompt.ts      the block that goes after your cached prefix
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
