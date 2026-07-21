import { findings } from "../../../../lib/demo-data";
import { PageIntro, Panel, PanelHeader, SourceRef } from "../../../../components/ui";

export default function DocumentationHealthPage() {
  return (
    <>
      <PageIntro
        eyebrow="03 / DOC HEALTH"
        title="Claims vs. code"
        summary="Deterministic stale-claim and coverage analysis. Every finding carries the code and documentation evidence used to produce it."
      />
      <div className="health-summary">
        <div>
          <strong>82</strong>
          <span>HEALTH SCORE</span>
        </div>
        <div>
          <strong>3</strong>
          <span>OPEN FINDINGS</span>
        </div>
        <div>
          <strong>1</strong>
          <span>UNDOCUMENTED API</span>
        </div>
        <div>
          <strong>94%</strong>
          <span>INDEX COMPLETENESS</span>
        </div>
      </div>
      <Panel>
        <PanelHeader
          eyebrow="ACTIVE REVISION 9f2c71a"
          title="Documentation findings"
          action={
            <div className="filter-pills">
              <button className="active" type="button">
                ALL 3
              </button>
              <button type="button">STALE 2</button>
              <button type="button">GAPS 1</button>
            </div>
          }
        />
        <div className="findings-list">
          {findings.map((finding) => (
            <article className="finding" key={finding.id}>
              <div className={`severity-bar severity-${finding.severity}`} />
              <div className="finding-id">
                <span>{finding.id}</span>
                <b className={`severity-text severity-${finding.severity}`}>{finding.severity}</b>
              </div>
              <div className="finding-copy">
                <h3>{finding.kind}</h3>
                <p>{finding.detail}</p>
                <SourceRef>{finding.evidence}</SourceRef>
              </div>
              <div className="suggestion">
                <span>SUGGESTED REPAIR</span>
                <p>{finding.suggestion}</p>
                <button type="button">PREVIEW FIX →</button>
              </div>
            </article>
          ))}
        </div>
      </Panel>
    </>
  );
}
