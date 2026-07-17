import type { GraphTraversal, TraversalResult } from "@intellirepo/graph";
import { describe, expect, it } from "vitest";

import { AffectedSubgraphCalculator } from "./affected-subgraph.js";
import { assembleChangeSummary, renderChangeSummaryMarkdown } from "./change-summary.js";
import { ImpactAnalyzer } from "./impact-analyzer.js";
import type {
  AffectedSubgraph,
  FactSnapshot,
  SnapshotEntity,
  SnapshotRelationship,
} from "./impact-model.js";
import { scoreRisk } from "./risk-scorer.js";
import { calculateSemanticDiff } from "./semantic-diff.js";
import { recommendTests } from "./test-recommender.js";

function entity(
  stableKey: string,
  kind: string,
  attributes: Readonly<Record<string, unknown>> = {},
): SnapshotEntity {
  return {
    attributes,
    id: `id-${stableKey}`,
    kind,
    name: stableKey,
    source: { artifactPath: `src/${stableKey}.ts`, evidence: stableKey, startLine: 1 },
    stableKey,
  };
}

function relationship(
  id: string,
  kind: string,
  sourceEntityKey: string,
  targetEntityKey: string,
  attributes: Readonly<Record<string, unknown>> = {},
): SnapshotRelationship {
  return { attributes, id, kind, sourceEntityKey, targetEntityKey };
}

function snapshot(
  revisionId: string,
  entities: readonly SnapshotEntity[],
  relationships: readonly SnapshotRelationship[],
): FactSnapshot {
  return { entities, relationships, repositoryId: "repo", revisionId };
}

function traversalFor(target: FactSnapshot): GraphTraversal {
  return {
    traverse: (query): Promise<TraversalResult> =>
      Promise.resolve({
        adapter: "postgresql",
        edges: target.relationships.map((edge) => ({
          attributes: edge.attributes,
          id: edge.id,
          kind: edge.kind,
          sourceId:
            target.entities.find(({ stableKey }) => stableKey === edge.sourceEntityKey)?.id ?? "",
          targetId:
            target.entities.find(({ stableKey }) => stableKey === edge.targetEntityKey)?.id ?? "",
        })),
        missingStartEntityKeys: [],
        nodes: target.entities.map((node) => ({
          attributes: node.attributes,
          id: node.id,
          kind: node.kind,
          name: node.name,
          stableKey: node.stableKey,
        })),
        projection: { requestedRevisionId: query.revisionId, state: "current" },
        repositoryId: query.repositoryId,
        revisionId: query.revisionId,
        truncated: false,
      }),
  };
}

describe("semantic impact", () => {
  it("classifies material facts while ignoring source relocation", () => {
    const original = entity("handler", "method", { signature: "login(a)" });
    const relocated = { ...original, source: { artifactPath: "src/new.ts", evidence: "handler" } };
    const modified = { ...relocated, attributes: { signature: "login(a, b)" } };

    expect(
      calculateSemanticDiff(snapshot("r1", [original], []), snapshot("r2", [relocated], []))
        .entities,
    ).toEqual([]);
    expect(
      calculateSemanticDiff(snapshot("r1", [original], []), snapshot("r2", [modified], []))
        .entities,
    ).toMatchObject([{ changedFields: ["attributes"], kind: "modified", stableKey: "handler" }]);
  });

  it("treats repeated call sites as one semantic dependency", () => {
    const caller = entity("caller", "method");
    const target = entity("target", "method");
    const first = {
      ...relationship("call-1", "CALLS", "caller", "target", { resolution: "symbol" }),
      sourceReference: {
        artifactPath: "src/caller.ts",
        evidence: "target()",
        startLine: 10,
      },
    };
    const second = {
      ...relationship("call-2", "CALLS", "caller", "target", { resolution: "symbol" }),
      sourceReference: {
        artifactPath: "src/caller.ts",
        evidence: "target()",
        startLine: 20,
      },
    };

    expect(
      calculateSemanticDiff(
        snapshot("r1", [caller, target], [first, second]),
        snapshot("r2", [caller, target], [second]),
      ).relationships,
    ).toEqual([]);
  });

  it("reaches APIs, services, tests, and docs without unrelated modules", async () => {
    const originalHandler = entity("auth-handler", "method", { signature: "login(input)" });
    const changedHandler = entity("auth-handler", "method", { signature: "login(input, otp)" });
    const entities = [
      changedHandler,
      entity("login-api", "endpoint"),
      entity("auth-service", "class"),
      entity("auth-handler-test", "test"),
      entity("login-doc", "documentation_page"),
      entity("unrelated", "module"),
    ];
    const relationships = [
      relationship("handles", "HANDLES", "login-api", "auth-handler"),
      relationship("calls", "CALLS", "auth-handler", "auth-service", { resolution: "symbol" }),
      relationship("tests", "TESTS", "auth-handler-test", "auth-handler", { basis: "call" }),
      relationship("documents", "DOCUMENTS", "login-doc", "login-api"),
    ];
    const base = snapshot("r1", [originalHandler, ...entities.slice(1)], relationships);
    const target = snapshot("r2", entities, relationships);
    const diff = calculateSemanticDiff(base, target);
    const affected = await new AffectedSubgraphCalculator(traversalFor(target)).calculate(
      diff,
      base,
      target,
    );

    expect(affected.entities.map(({ entity: value }) => value.stableKey)).toEqual([
      "auth-handler",
      "auth-handler-test",
      "login-api",
      "login-doc",
      "auth-service",
    ]);
    expect(affected.entities.some(({ entity: value }) => value.stableKey === "unrelated")).toBe(
      false,
    );
    expect(recommendTests(diff, affected)).toMatchObject([
      {
        confidence: { level: "confirmed" },
        score: 0.95,
        testEntity: { stableKey: "auth-handler-test" },
      },
    ]);
  });

  it("discounts naming-only test relationships", async () => {
    const before = entity("service", "class", { signature: "before" });
    const after = entity("service", "class", { signature: "after" });
    const test = entity("service-test", "test");
    const relationships = [
      relationship("naming-test", "TESTS", "service-test", "service", {
        basis: "naming",
      }),
    ];
    const base = snapshot("r1", [before, test], relationships);
    const target = snapshot("r2", [after, test], relationships);
    const diff = calculateSemanticDiff(base, target);
    const affected = await new AffectedSubgraphCalculator(traversalFor(target)).calculate(
      diff,
      base,
      target,
    );

    expect(recommendTests(diff, affected)).toMatchObject([
      { confidence: { level: "inferred", score: 0.5225 }, score: 0.5225 },
    ]);
  });

  it("recommends an isolated naming-convention candidate", () => {
    const before = entity("PaymentService", "class", { signature: "before" });
    const after = entity("PaymentService", "class", { signature: "after" });
    const diff = calculateSemanticDiff(snapshot("r1", [before], []), snapshot("r2", [after], []));
    const affected: AffectedSubgraph = {
      entities: [
        {
          changeKind: "modified",
          confidence: 1,
          entity: after,
          evidencePath: [],
          reason: "modified",
        },
      ],
      repositoryId: "repo",
      revisionId: "r2",
      truncated: false,
    };

    expect(recommendTests(diff, affected, [entity("PaymentServiceTest", "test")])).toMatchObject([
      { reason: "Test name matches a changed entity", score: 0.55 },
    ]);
  });

  it("bounds high-degree utility expansion", async () => {
    const utility = entity("utility", "function", { signature: "before" });
    const changed = entity("utility", "function", { signature: "after" });
    const callers = Array.from({ length: 20 }, (_, index) => entity(`caller-${index}`, "function"));
    const relationships = callers.map((caller, index) =>
      relationship(`call-${index}`, "CALLS", caller.stableKey, "utility", { resolution: "symbol" }),
    );
    const base = snapshot("r1", [utility, ...callers], relationships);
    const target = snapshot("r2", [changed, ...callers], relationships);
    const affected = await new AffectedSubgraphCalculator(traversalFor(target)).calculate(
      calculateSemanticDiff(base, target),
      base,
      target,
      { maxFanOut: 3 },
    );

    expect(affected.entities).toHaveLength(4);
    expect(affected.truncated).toBe(true);
  });

  it("retains base-revision paths for deleted entities", async () => {
    const removed = entity("removed-service", "class");
    const caller = entity("caller", "method");
    const documentation = entity("service-doc", "documentation_page");
    const base = snapshot(
      "r1",
      [removed, caller, documentation],
      [
        relationship("old-call", "CALLS", "caller", "removed-service", { resolution: "symbol" }),
        relationship("old-doc", "DOCUMENTS", "service-doc", "removed-service"),
      ],
    );
    const target = snapshot("r2", [caller, documentation], []);
    const affected = await new AffectedSubgraphCalculator(traversalFor(target)).calculate(
      calculateSemanticDiff(base, target),
      base,
      target,
    );

    expect(
      affected.entities.find(({ entity: value }) => value.stableKey === "caller")?.evidencePath,
    ).toMatchObject([{ relationshipId: "old-call", sourceRevision: "base" }]);
  });
});

describe("risk and summary", () => {
  it("scores explicit factors deterministically and renders traceable Markdown", () => {
    const before = entity("auth-endpoint", "endpoint", { path: "/login" });
    const after = entity("auth-endpoint", "endpoint", { path: "/v2/login" });
    const diff = calculateSemanticDiff(snapshot("r1", [before], []), snapshot("r2", [after], []));
    const affected: AffectedSubgraph = {
      entities: [
        {
          changeKind: "modified",
          confidence: 1,
          entity: after,
          evidencePath: [],
          reason: "modified",
        },
      ],
      repositoryId: "repo",
      revisionId: "r2",
      truncated: false,
    };
    const first = scoreRisk({
      affected,
      changedFileCount: 2,
      diff,
      missingDocumentationCount: 1,
      tests: [],
      unresolvedRelationshipCount: 1,
    });
    const second = scoreRisk({
      affected,
      changedFileCount: 2,
      diff,
      missingDocumentationCount: 1,
      tests: [],
      unresolvedRelationshipCount: 1,
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ level: "High" });
    expect(first.factors.map(({ factor }) => factor)).toEqual([
      "authentication-or-authorization",
      "public-api",
      "missing-tests",
      "documentation-gap",
      "unresolved-relationships",
    ]);

    const report = assembleChangeSummary({
      affected,
      behaviorChanges: [
        {
          classification: "inferred",
          evidence: [],
          statement: "Login clients may need the v2 route",
        },
      ],
      changedFiles: ["src/auth.ts"],
      diff,
      risk: first,
      tests: [],
    });
    const markdown = renderChangeSummaryMarkdown(report);
    expect(markdown).toContain("**Inferred:** Login clients may need the v2 route");
    expect(markdown).toContain("src/auth-endpoint.ts:1");
    expect(markdown).toContain("Risk: **High");
  });

  it("covers configuration, persistence, downstream, and change-size factors", () => {
    const configBefore = entity("cache-ttl", "configuration_key", { value: 30 });
    const configAfter = entity("cache-ttl", "configuration_key", { value: 15 });
    const repositoryBefore = entity("UserRepository", "class", { signature: "find(id)" });
    const repositoryAfter = entity("UserRepository", "class", {
      signature: "find(id, tenant)",
    });
    const diff = calculateSemanticDiff(
      snapshot("r1", [configBefore, repositoryBefore], []),
      snapshot("r2", [configAfter, repositoryAfter], []),
    );
    const affected: AffectedSubgraph = {
      entities: [
        {
          changeKind: "modified",
          confidence: 1,
          entity: configAfter,
          evidencePath: [],
          reason: "modified",
        },
        {
          changeKind: "modified",
          confidence: 1,
          entity: repositoryAfter,
          evidencePath: [],
          reason: "modified",
        },
        {
          confidence: 0.8,
          entity: entity("consumer", "class"),
          evidencePath: [],
          reason: "downstream",
        },
      ],
      repositoryId: "repo",
      revisionId: "r2",
      truncated: false,
    };

    expect(
      scoreRisk({ affected, changedFileCount: 10, diff, tests: [] }).factors.map(
        ({ factor }) => factor,
      ),
    ).toEqual([
      "configuration",
      "persistence",
      "downstream-impact",
      "missing-tests",
      "change-size",
    ]);
  });

  it("exposes the complete workflow through one analyzer interface", async () => {
    const before = entity("handler", "method", { signature: "before" });
    const after = entity("handler", "method", { signature: "after" });
    const target = snapshot("r2", [after], []);
    const report = await new ImpactAnalyzer(traversalFor(target)).analyze({
      base: snapshot("r1", [before], []),
      changedFiles: ["src/handler.ts"],
      target,
    });

    expect(report).toMatchObject({
      baseRevisionId: "r1",
      changedFiles: ["src/handler.ts"],
      diff: { summary: { added: 0, modified: 1, removed: 0 } },
      targetRevisionId: "r2",
    });
  });
});
