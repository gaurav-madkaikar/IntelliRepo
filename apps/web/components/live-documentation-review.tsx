"use client";

import { useState } from "react";
import type {
  DocumentationPreviewRequest,
  DocumentationReviewResponse,
} from "@intellirepo/contracts";

import { ProductApiClient } from "../lib/product-api";
import { Panel, PanelHeader, SourceRef } from "./ui";

export function LiveDocumentationReview({ repositoryId }: { readonly repositoryId: string }) {
  const [request, setRequest] = useState<DocumentationPreviewRequest>({
    kind: "architecture",
    title: "Architecture",
  });
  const [preview, setPreview] = useState<DocumentationReviewResponse>();
  const [state, setState] = useState<"idle" | "loading" | "applied">("idle");
  const [error, setError] = useState<string>();
  const createPreview = async (): Promise<void> => {
    setState("loading");
    setError(undefined);
    try {
      setPreview(await new ProductApiClient().previewDocumentation(repositoryId, request));
      setState("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preview failed");
      setState("idle");
    }
  };
  const apply = async (): Promise<void> => {
    if (preview === undefined) return;
    setState("loading");
    setError(undefined);
    try {
      await new ProductApiClient().applyDocumentation(repositoryId, preview.id, { accepted: true });
      setState("applied");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Apply failed");
      setState("idle");
    }
  };
  return (
    <>
      <form
        className="document-toolbar live-document-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void createPreview();
        }}
      >
        <label>
          <span>TITLE</span>
          <input
            value={request.title}
            onChange={(event) => setRequest({ ...request, title: event.target.value })}
          />
        </label>
        <label>
          <span>KIND</span>
          <select
            value={request.kind}
            onChange={(event) =>
              setRequest({
                ...request,
                kind: event.target.value as DocumentationPreviewRequest["kind"],
              })
            }
          >
            <option value="architecture">architecture</option>
            <option value="onboarding">onboarding</option>
            <option value="configuration">configuration</option>
            <option value="module">module</option>
            <option value="api">api</option>
          </select>
        </label>
        <button disabled={state === "loading"} type="submit">
          PREVIEW DIFF →
        </button>
      </form>
      {error === undefined ? null : <div className="inline-error">{error}</div>}
      <div className="documentation-layout live-documentation-layout">
        <Panel className="diff-panel">
          <PanelHeader
            eyebrow={
              preview === undefined ? "NO PREVIEW" : `PENDING REVIEW · ${preview.id.slice(0, 18)}`
            }
            title="Local Markdown diff"
          />
          <pre className="live-diff">
            <code>
              {preview?.diff ?? "Choose a document kind and create a revision-scoped preview."}
            </code>
          </pre>
          <div className="source-strip">
            <span>SOURCES</span>
            {(preview?.manifest.sourceReferences ?? []).map((source) => (
              <SourceRef key={source}>{source}</SourceRef>
            ))}
          </div>
        </Panel>
        <Panel className="review-panel">
          <PanelHeader eyebrow="HUMAN REVIEW" title="Apply gate" />
          <dl>
            <dt>Target</dt>
            <dd>
              <code>{preview?.path ?? "—"}</code>
            </dd>
            <dt>Revision</dt>
            <dd>
              <code>{preview?.revisionId ?? "—"}</code>
            </dd>
            <dt>AI enhancement</dt>
            <dd>{preview?.enhancement.state ?? "—"}</dd>
            <dt>State</dt>
            <dd>{state}</dd>
          </dl>
          <button
            disabled={preview === undefined || state !== "idle"}
            onClick={() => void apply()}
            type="button"
          >
            APPLY ACCEPTED DIFF →
          </button>
        </Panel>
      </div>
    </>
  );
}
