"use client";

import { useState } from "react";
import type { EntitySearchResult, GraphNeighborhoodResponse } from "@intellirepo/contracts";

import { ProductApiClient } from "../lib/product-api";
import { boundedResultLabel } from "../lib/dashboard-model";
import { Panel, PanelHeader } from "./ui";

export function LiveGraphExplorer({ repositoryId }: { readonly repositoryId: string }) {
  const [query, setQuery] = useState("");
  const [entities, setEntities] = useState<EntitySearchResult>();
  const [graph, setGraph] = useState<GraphNeighborhoodResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const search = async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await new ProductApiClient().searchEntities(repositoryId, {
        limit: 25,
        query,
      });
      setEntities(result);
      setGraph(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Entity search failed");
    } finally {
      setLoading(false);
    }
  };
  const expand = async (stableKey: string): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      setGraph(
        await new ProductApiClient().graph(repositoryId, {
          direction: "both",
          maxDepth: 3,
          maxNodes: 200,
          mode: "neighborhood",
          relationshipKinds: [],
          startEntityKeys: [stableKey],
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Graph traversal failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <form
        className="explorer-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label>
          <span>SEARCH CANONICAL ENTITY</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="AuthService or POST /api/login"
            value={query}
          />
        </label>
        <div />
        <div />
        <button disabled={loading || query.trim().length === 0} type="submit">
          {loading ? "QUERYING…" : "RUN QUERY →"}
        </button>
      </form>
      {error === undefined ? null : <div className="inline-error">{error}</div>}
      <div className="explorer-layout live-explorer-layout">
        <Panel className="entity-results">
          <PanelHeader eyebrow={`${entities?.total ?? 0} MATCHES`} title="Entities" />
          {(entities?.items ?? []).map((entity) => (
            <button
              className="entity-row"
              key={entity.id}
              onClick={() => void expand(entity.stableKey)}
              type="button"
            >
              <span className={`entity-kind kind-${entity.kind}`}>
                {entity.kind.slice(0, 2).toUpperCase()}
              </span>
              <div>
                <strong>{entity.qualifiedName ?? entity.name}</strong>
                <small>
                  {entity.kind} · {entity.language ?? "unknown"}
                </small>
              </div>
              <span>›</span>
            </button>
          ))}
          {entities !== undefined && entities.items.length === 0 ? (
            <div className="live-empty">No canonical entity matched.</div>
          ) : null}
        </Panel>
        <Panel className="graph-panel">
          <PanelHeader
            eyebrow={
              graph === undefined
                ? "BOUNDED POSTGRESQL TRAVERSAL"
                : boundedResultLabel(graph.nodes.length, 200, graph.truncated)
            }
            title="Neighborhood"
          />
          <div className="live-graph-list">
            {(graph?.nodes ?? []).map((node) => (
              <article key={node.id}>
                <span>{node.kind}</span>
                <strong>{node.qualifiedName ?? node.name}</strong>
                <code>{node.stableKey}</code>
              </article>
            ))}
            {graph === undefined ? (
              <div className="live-empty">
                Search, then select an entity to traverse its revision-scoped neighborhood.
              </div>
            ) : null}
          </div>
        </Panel>
        <Panel className="evidence-drawer">
          <PanelHeader
            eyebrow="CANONICAL EDGES"
            title={`${graph?.edges.length ?? 0} relationships`}
          />
          <div className="live-edge-list">
            {(graph?.edges ?? []).map((edge) => (
              <code key={edge.id}>
                {edge.kind} · {edge.sourceId.slice(0, 8)} → {edge.targetId.slice(0, 8)}
              </code>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
