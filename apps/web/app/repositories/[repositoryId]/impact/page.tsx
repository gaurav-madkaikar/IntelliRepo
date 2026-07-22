import { ProductErrorState } from "../../../../components/product-error-state";
import { Confidence, PageIntro, Panel, PanelHeader } from "../../../../components/ui";
import { ProductApiClient } from "../../../../lib/product-api";

export default async function ImpactPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ repositoryId: string }>;
  readonly searchParams: Promise<{ baseRevisionId?: string; targetRevisionId?: string }>;
}) {
  const [{ repositoryId }, query] = await Promise.all([params, searchParams]);
  if (query.baseRevisionId === undefined || query.targetRevisionId === undefined)
    return (
      <ProductErrorState
        title="Choose a revision pair"
        reason="Add baseRevisionId and targetRevisionId query parameters from a completed incremental scan."
      />
    );
  let impact;
  try {
    impact = await new ProductApiClient().impact(repositoryId, {
      baseRevisionId: query.baseRevisionId,
      targetRevisionId: query.targetRevisionId,
    });
  } catch (error) {
    return (
      <ProductErrorState
        reason={error instanceof Error ? error.message : "Impact report unavailable"}
      />
    );
  }
  return (
    <>
      <PageIntro
        eyebrow="04 / IMPACT"
        title="Change radius"
        summary="A deterministic report from semantic diffs and bounded traversal, with every risk point explained."
      />
      <div className="revision-compare">
        <div>
          <span>BASE</span>
          <code>{impact.baseRevisionId}</code>
        </div>
        <span className="compare-arrow">→</span>
        <div>
          <span>TARGET</span>
          <code>{impact.targetRevisionId}</code>
        </div>
        <div className="risk-badge">
          <span>RISK</span>
          <strong>{impact.risk.level}</strong>
          <b>{impact.risk.score}/100</b>
        </div>
      </div>
      <div className="dashboard-grid">
        <Panel className="span-7">
          <PanelHeader
            eyebrow={`${impact.changedFiles.length} CHANGED FILES`}
            title="Affected components"
          />
          <div className="live-impact-groups">
            <section>
              <span>APIS</span>
              {impact.affectedApis.map((item) => (
                <code key={item}>{item}</code>
              ))}
            </section>
            <section>
              <span>MODULES</span>
              {impact.affectedModules.map((item) => (
                <code key={item}>{item}</code>
              ))}
            </section>
            <section>
              <span>DOCUMENTATION</span>
              {impact.affectedDocumentation.map((item) => (
                <code key={item}>{item}</code>
              ))}
            </section>
          </div>
        </Panel>
        <Panel className="span-5">
          <PanelHeader eyebrow="EXPLAINABLE SCORE" title="Risk factors" />
          <div className="risk-meter">
            <span style={{ width: `${impact.risk.score}%` }} />
          </div>
          <div className="factor-list">
            {impact.risk.factors.map((factor) => (
              <div key={factor.factor}>
                <span>{factor.explanation}</span>
                <strong>+{factor.weight}</strong>
              </div>
            ))}
          </div>
        </Panel>
        <Panel className="span-7">
          <PanelHeader eyebrow="TEST IMPACT" title="Recommended verification" />
          {impact.tests.map((test) => (
            <div className="test-row" key={test.testEntity.stableKey}>
              <span>◆</span>
              <div>
                <strong>{test.testEntity.name}</strong>
                <p>{test.reason}</p>
              </div>
              <Confidence level={test.confidence.level} />
            </div>
          ))}
        </Panel>
        <Panel className="span-5">
          <PanelHeader eyebrow="REVIEW FOCUS" title="What deserves attention" />
          <ol className="review-list">
            {impact.reviewFocus.map((focus, index) => (
              <li key={focus}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                {focus}
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </>
  );
}
