import { capabilityData, demoRepository, metrics, scanStages } from "../../../../lib/demo-data";
import { ArrowLink, PageIntro, Panel, PanelHeader, StatusDot } from "../../../../components/ui";

export default async function OverviewPage({
  params,
}: {
  readonly params: Promise<{ repositoryId: string }>;
}) {
  const { repositoryId } = await params;
  return (
    <>
      <PageIntro
        eyebrow="01 / OVERVIEW"
        title="Repository pulse"
        summary="Canonical facts, projection freshness, and the latest indexing run—without hiding degraded capabilities."
      />
      <div className="metrics-grid">
        {metrics.map((metric) => (
          <article className="metric" key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.delta}</small>
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
                <StatusDot state="current" /> COMPLETED
              </span>
            }
          />
          <div className="pipeline">
            {scanStages.map(([stage, time], index) => (
              <div className={time === "skipped" ? "stage skipped" : "stage"} key={stage}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <b>{stage}</b>
                <small>{time}</small>
              </div>
            ))}
          </div>
          <div className="run-meta">
            <div>
              <span>REVISION</span>
              <code>{demoRepository.revision}</code>
            </div>
            <div>
              <span>DURATION</span>
              <strong>7.82 s</strong>
            </div>
            <div>
              <span>FILES CHANGED</span>
              <strong>8 / 438</strong>
            </div>
            <div>
              <span>MODE</span>
              <strong>incremental</strong>
            </div>
          </div>
        </Panel>
        <Panel className="span-4 health-panel">
          <PanelHeader eyebrow="DOCUMENTATION" title="Health score" />
          <div className="health-score">
            <svg viewBox="0 0 120 120" role="img" aria-label="Documentation health 82 out of 100">
              <circle cx="60" cy="60" r="48" />
              <circle className="score-ring" cx="60" cy="60" r="48" />
            </svg>
            <div>
              <strong>82</strong>
              <span>/ 100</span>
            </div>
          </div>
          <p>Three confirmed findings are holding the score below the healthy threshold.</p>
          <ArrowLink href={`/repositories/${repositoryId}/documentation-health`}>
            Review findings
          </ArrowLink>
        </Panel>
        <Panel className="span-7">
          <PanelHeader eyebrow="RUNTIME TRUTH" title="Capability matrix" />
          <div className="capability-table">
            {capabilityData.map((item) => (
              <div key={item.label}>
                <StatusDot state={item.state} />
                <strong>{item.label}</strong>
                <span>{item.detail}</span>
                <code>{item.lag}</code>
              </div>
            ))}
          </div>
          <div className="degraded-note">
            <b>DEGRADED, NOT BLOCKED</b>
            <span>
              Neo4j and Ollama are offline. PostgreSQL traversal and deterministic evidence remain
              operational.
            </span>
          </div>
        </Panel>
        <Panel className="span-5">
          <PanelHeader eyebrow="DISCOVERY" title="Entity inventory" />
          <div className="inventory-bars">
            {[
              ["Methods", 526, 84],
              ["Classes", 214, 56],
              ["Relationships", 2941, 100],
              ["Endpoints", 24, 22],
              ["Tests", 87, 38],
            ].map(([label, value, width]) => (
              <div key={String(label)}>
                <span>{label}</span>
                <div>
                  <i style={{ width: `${String(width)}%` }} />
                </div>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <ArrowLink href={`/repositories/${repositoryId}/explorer`}>Open graph explorer</ArrowLink>
        </Panel>
      </div>
    </>
  );
}
