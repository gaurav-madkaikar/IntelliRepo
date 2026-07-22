import { ProductErrorState } from "../../../../components/product-error-state";
import { ArrowLink, PageIntro, Panel, PanelHeader, StatusDot } from "../../../../components/ui";
import { loadDashboardData } from "../../../../lib/product-api";

const stages = [
  "DISCOVERING",
  "PARSING",
  "RESOLVING",
  "COMMITTING_FACTS",
  "PROJECTING_GRAPH",
  "EMBEDDING",
  "ANALYZING",
] as const;

export default async function OverviewPage({
  params,
}: {
  readonly params: Promise<{ repositoryId: string }>;
}) {
  const { repositoryId } = await params;
  const data = await loadDashboardData(repositoryId);
  if (data.mode === "error") return <ProductErrorState reason={data.reason} />;
  const { overview } = data;
  const metrics = Object.entries(overview.counts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4);
  const capabilities = [
    ["PostgreSQL canonical", overview.capabilities.canonical],
    ["pgvector semantic", overview.capabilities.semantic],
    ["Revision analysis", overview.capabilities.analysis],
    ["Ollama local", overview.capabilities.ollama],
    ["Scan dispatch", overview.capabilities.worker],
  ] as const;
  const currentIndex = overview.latestJob?.currentStage
    ? stages.indexOf(overview.latestJob.currentStage)
    : overview.latestJob?.state === "COMPLETED"
      ? stages.length
      : -1;
  const health = overview.documentationHealth?.score ?? 0;

  return (
    <>
      <PageIntro
        eyebrow="01 / OVERVIEW"
        title="Repository pulse"
        summary="Canonical facts, projection freshness, and the latest indexing run—without hiding degraded capabilities."
      />
      <div className="metrics-grid">
        {(metrics.length === 0 ? [["entities", 0] as const] : metrics).map(([label, value]) => (
          <article className="metric" key={label}>
            <span>{label.replaceAll("_", " ")}</span>
            <strong>{value.toLocaleString()}</strong>
            <small>canonical facts</small>
          </article>
        ))}
      </div>
      <div className="dashboard-grid">
        <Panel className="span-8">
          <PanelHeader
            eyebrow="LATEST RUN"
            title="Index pipeline"
            action={
              <span className="run-state">
                <StatusDot state={overview.latestJob?.state === "FAILED" ? "failed" : "current"} />
                {overview.latestJob?.state ?? "NOT STARTED"}
              </span>
            }
          />
          <div className="pipeline pipeline-seven">
            {stages.map((stage, index) => {
              const stageState =
                index < currentIndex ? "complete" : index === currentIndex ? "active" : "pending";
              return (
                <div className={`stage stage-${stageState}`} key={stage}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <b>{stage.replaceAll("_", " ")}</b>
                  <small>{stageState}</small>
                </div>
              );
            })}
          </div>
          <div className="run-meta">
            <div>
              <span>REVISION</span>
              <code>{overview.revision?.commitSha.slice(0, 12) ?? "none"}</code>
            </div>
            <div>
              <span>ATTEMPT</span>
              <strong>{overview.latestJob?.attempt ?? 0}</strong>
            </div>
            <div>
              <span>DISPATCH</span>
              <strong>{overview.capabilities.worker.dispatchMode}</strong>
            </div>
            <div>
              <span>UPDATED</span>
              <strong>
                {overview.latestJob
                  ? new Date(overview.latestJob.updatedAt).toLocaleTimeString()
                  : "—"}
              </strong>
            </div>
          </div>
          {(overview.latestJob?.degradedReasons.length ?? 0) > 0 ? (
            <div className="degraded-note">
              <b>DEGRADED, NOT BLOCKED</b>
              <span>{overview.latestJob?.degradedReasons.join(" · ")}</span>
            </div>
          ) : null}
        </Panel>
        <Panel className="span-4 health-panel">
          <PanelHeader eyebrow="DOCUMENTATION" title="Health score" />
          <div className="health-score">
            <svg
              viewBox="0 0 120 120"
              role="img"
              aria-label={`Documentation health ${health} out of 100`}
            >
              <circle cx="60" cy="60" r="48" />
              <circle
                className="score-ring"
                cx="60"
                cy="60"
                r="48"
                style={{ strokeDashoffset: 302 - (302 * health) / 100 }}
              />
            </svg>
            <div>
              <strong>{health}</strong>
              <span>/ 100</span>
            </div>
          </div>
          <p>
            {overview.documentationHealth?.explanation ??
              "Analysis has not completed for this revision."}
          </p>
          <ArrowLink href={`/repositories/${repositoryId}/documentation-health`}>
            Review findings
          </ArrowLink>
        </Panel>
        <Panel className="span-7">
          <PanelHeader eyebrow="RUNTIME TRUTH" title="Capability matrix" />
          <div className="capability-table">
            {capabilities.map(([label, capability]) => (
              <div key={label}>
                <StatusDot state={capability.state} />
                <strong>{label}</strong>
                <span>{capability.detail}</span>
                <code>{capability.lagRevisions} rev</code>
              </div>
            ))}
          </div>
        </Panel>
        <Panel className="span-5">
          <PanelHeader eyebrow="CANONICAL TARGET" title="Repository identity" />
          <dl className="live-repository-facts">
            <dt>Path</dt>
            <dd>
              <code>{overview.repository.rootPath}</code>
            </dd>
            <dt>Branch</dt>
            <dd>{overview.repository.defaultBranch ?? "detached"}</dd>
            <dt>Revision</dt>
            <dd>
              <code>{overview.revision?.id ?? "not indexed"}</code>
            </dd>
            <dt>Traversal</dt>
            <dd>{overview.selectedTraversalAdapter}</dd>
          </dl>
          <ArrowLink href={`/repositories/${repositoryId}/explorer`}>Open graph explorer</ArrowLink>
        </Panel>
      </div>
    </>
  );
}
