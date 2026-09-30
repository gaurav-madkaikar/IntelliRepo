import { ProductErrorState } from "../../../../components/product-error-state";
import { PageIntro, Panel, PanelHeader } from "../../../../components/ui";
import { ProductApiClient } from "../../../../lib/product-api";

export default async function DocumentationHealthPage({
  params,
}: {
  readonly params: Promise<{ repositoryId: string }>;
}) {
  const { repositoryId } = await params;
  let health;
  try {
    health = await new ProductApiClient().documentationHealth(repositoryId, {});
  } catch (error) {
    return (
      <ProductErrorState
        reason={error instanceof Error ? error.message : "Documentation API unavailable"}
      />
    );
  }
  return (
    <>
      <PageIntro
        eyebrow="03 / DOC HEALTH"
        title="Claims vs. code"
        summary="Deterministic stale-claim and coverage analysis. Every finding carries the evidence used to produce it."
      />
      <div className="health-summary">
        <div>
          <strong>{health.score}</strong>
          <span>HEALTH SCORE</span>
        </div>
        <div>
          <strong>{health.findings.length}</strong>
          <span>OPEN FINDINGS</span>
        </div>
        <div>
          <strong>
            {health.findings.filter(({ kind }) => kind === "missing_documentation").length}
          </strong>
          <span>DOCUMENTATION GAPS</span>
        </div>
        <div>
          <strong>{health.revisionId.slice(0, 8)}</strong>
          <span>ACTIVE REVISION</span>
        </div>
      </div>
      <Panel>
        <PanelHeader
          eyebrow={`ACTIVE REVISION ${health.revisionId}`}
          title="Documentation findings"
        />
        {health.findings.length === 0 ? (
          <div className="live-empty">No findings for the active canonical revision.</div>
        ) : (
          <div className="findings-list">
            {health.findings.map((finding) => (
              <article className="finding" key={finding.id}>
                <div className={`severity-bar severity-${finding.severity}`} />
                <div className="finding-id">
                  <span>{finding.id.slice(0, 16)}</span>
                  <b className={`severity-text severity-${finding.severity}`}>{finding.severity}</b>
                </div>
                <div className="finding-copy">
                  <h3>{finding.kind.replaceAll("_", " ")}</h3>
                  <p>{String(finding.evidence.message ?? health.explanation)}</p>
                </div>
                <div className="suggestion">
                  <span>STATUS</span>
                  <p>{finding.status}</p>
                  <code>{JSON.stringify(finding.evidence)}</code>
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
