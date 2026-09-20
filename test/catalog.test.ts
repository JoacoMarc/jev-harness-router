import { describe, expect, expectTypeOf, it } from "vitest";
import { Catalog, defineCatalog } from "../src/catalog/index.ts";
import { heuristicRoute, isShortcut } from "../src/heuristic.ts";
import { Q, buildQuestions } from "../src/questions.ts";
import { createRouter } from "../src/router.ts";
import { availableTools } from "../src/state.ts";
import { mockFetch } from "../src/mock.ts";
import { fakeJev } from "./helpers.ts";

/**
 * The router on a catalogue that is not the shipped one.
 *
 * Two tiers, two tools, two skills, different names for everything, in a different
 * language. If anything in `src/` still reaches for the default catalogue by name, it
 * shows up here as a wrong tier, a missing question or a type that did not narrow.
 */
const catalog = defineCatalog({
  models: [
    { tier: "small", id: "gpt-5-mini", label: "Mini", use: "Quick edits.", hints: [] },
    {
      tier: "large",
      id: "gpt-5",
      label: "Full",
      use: "Anything with design in it.",
      hints: [/\b(architektur\w*|umbau\w*)\b/i],
    },
  ],
  tools: {
    read_file: { description: "Open a file the user pointed at.", risk: "read", hints: [/\blies\b/i] },
    shell: { description: "Run a shell command.", risk: "execute", hints: [/\bfuhr\w*\b.*\baus\b/i] },
  },
  skills: {
    deploy: { description: "Ship a release safely.", hints: [/\bdeploy\w*\b/i], detail: "Checks CI, flags, rollback." },
    postmortem: { description: "Write up an incident after the fact.", hints: [/\bpostmortem\b/i] },
  },
  shortcuts: { commandPrefix: /^!/, continuations: ["weiter", "ja"] },
});

describe("a catalogue of your own", () => {
  it("derives its ladder, ids and fingerprint from the spec", () => {
    expect(catalog).toBeInstanceOf(Catalog);
    expect(catalog.tiers).toEqual(["small", "large"]);
    expect(catalog.toolIds).toEqual(["read_file", "shell"]);
    expect(catalog.skillIds).toEqual(["deploy", "postmortem"]);
    expect(catalog.version).toHaveLength(12);
    expect(catalog.modelFor("large").id).toBe("gpt-5");
    expect(catalog.thresholdFor("shell")).toBe(0.8);
  });

  it("narrows the route types to the catalogue's own names", () => {
    const router = createRouter({ catalog, fetch: fakeJev() });
    type Route = Awaited<ReturnType<typeof router.route>>;
    expectTypeOf<Route["tier"]>().toEqualTypeOf<"small" | "large">();
    expectTypeOf<Route["skill"]>().toEqualTypeOf<"deploy" | "postmortem" | null>();
    expectTypeOf<Route["tools"]>().toEqualTypeOf<readonly ("read_file" | "shell")[]>();
  });

  it("accepts the plain spec too, and infers the same types", () => {
    const router = createRouter({
      catalog: {
        models: [{ tier: "only", id: "m", label: "M", use: "Everything." }],
        tools: { look: { description: "Look.", risk: "read" } },
        skills: {},
      },
      fetch: fakeJev(),
    });
    type Route = Awaited<ReturnType<typeof router.route>>;
    expectTypeOf<Route["tier"]>().toEqualTypeOf<"only">();
    expect(router.catalog.tiers).toEqual(["only"]);
  });

  it("uses the catalogue's own shortcuts", () => {
    expect(isShortcut({ message: "!build" }, catalog)).toBe(true);
    expect(isShortcut({ message: "weiter" }, catalog)).toBe(true);
    // The default catalogue's shortcuts mean nothing here.
    expect(isShortcut({ message: "/commit" }, catalog)).toBe(false);
    expect(isShortcut({ message: "dale" }, catalog)).toBe(false);
  });

  it("asks one Noul per catalogue tool and offers every catalogue skill", () => {
    const questions = buildQuestions(availableTools({ message: "x" }, catalog), {}, catalog);
    expect(questions).toHaveProperty("tool::read_file");
    expect(questions).toHaveProperty("tool::shell");
    expect(questions).not.toHaveProperty("tool::Read");
    expect(Object.keys(questions[Q.skill].criteria).sort()).toEqual(["deploy", "none", "postmortem"]);
  });

  it("routes end to end through the router, in both lanes that touch the catalogue", async () => {
    const router = createRouter({
      catalog,
      fetch: fakeJev({
        answers: {
          "gate::acts_on_system": { type: "noul", noul: 0.95 },
          "gate::follows_procedure": { type: "noul", noul: 0.9 },
          "gate::produces_artifact": { type: "noul", noul: 0.9 },
          "gate::prose_suffices": { type: "noul", noul: 0.05 },
          [Q.difficulty]: { type: "score", score: 3, confidence: 0.9, legend: {}, probabilities: { "3": 1 } },
          [Q.skill]: { type: "choice", choice: "deploy", confidence: 0.95, probabilities: { deploy: 0.95, postmortem: 0.03, none: 0.02 } },
          "tool::shell": { type: "noul", noul: 0.9 },
        },
      }),
    });

    const route = await router.route({ message: "deploy the release" });
    expect(route.source).toBe("jev");
    expect(route.tier).toBe("large");
    expect(route.model).toBe("gpt-5");
    expect(route.tools).toEqual(["shell"]);
    expect(route.skill).toBe("deploy");

    const shortcut = await router.route({ message: "!status" });
    expect(shortcut.source).toBe("shortcut");
    expect(shortcut.tier).toBe("small");
    expect(shortcut.model).toBe("gpt-5-mini");
  });

  it("falls back to a heuristic driven by this catalogue's hints", () => {
    const route = heuristicRoute(
      { message: "Umbau der Architektur, lies die Datei und führe das Deployment aus" },
      catalog,
    );
    expect(route.tier).toBe("large");
    expect(route.tools).toEqual(["read_file", "shell"]);
    expect(route.skill).toBe("deploy");
  });

  it("drives the offline mock from the same catalogue", async () => {
    const router = createRouter({ catalog, fetch: mockFetch(catalog) });
    const route = await router.route({ message: "deploy it, lies die config" });
    expect(route.source).toBe("jev");
    expect(route.skill).toBe("deploy");
    expect(route.tools).toContain("read_file");
  });

  it("keeps cache keys apart between catalogues", async () => {
    const calls = { n: 0, bodies: [] as unknown[] };
    const a = createRouter({ catalog, fetch: fakeJev({ calls }) });
    const b = createRouter({ fetch: fakeJev({ calls }) });
    await a.route({ message: "same words" });
    await b.route({ message: "same words" });
    expect(calls.n).toBe(2);
  });
});

describe("defineCatalog validation", () => {
  const base = { models: [{ tier: "t", id: "m", label: "M", use: "u" }], tools: {}, skills: {} };

  it("rejects an empty ladder", () => {
    expect(() => defineCatalog({ ...base, models: [] })).toThrow(/at least one model tier/);
  });

  it("rejects duplicate tiers", () => {
    expect(() =>
      defineCatalog({ ...base, models: [...base.models, { tier: "t", id: "n", label: "N", use: "u" }] }),
    ).toThrow(/Duplicate tier/);
  });

  it("reserves none for the no-match option", () => {
    expect(() => defineCatalog({ ...base, skills: { none: { description: "x" } } })).toThrow(/reserved/);
  });

  it("keeps the namespace separator out of ids", () => {
    expect(() =>
      defineCatalog({ ...base, tools: { "a::b": { description: "x", risk: "read" } } }),
    ).toThrow(/::/);
  });
});
