import { impact } from "../../../../lib/demo-data";
import { Confidence, PageIntro, Panel, PanelHeader, SourceRef } from "../../../../components/ui";

export default function ImpactPage() {
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
          <code>77ab193</code>
          <small>main · 14 min ago</small>
        </div>
        <span className="compare-arrow">→</span>
        <div>
          <span>TARGET</span>
          <code>9f2c71a</code>
          <small>worktree · current</small>
        </div>
        <div className="risk-badge">
          <span>RISK</span>
          <strong>{impact.riskLevel}</strong>
          <b>{impact.risk}/100</b>
        </div>
      </div>
      <div className="dashboard-grid">
        <Panel className="span-7">
          <PanelHeader eyebrow="AFFECTED SUBGRAPH · POSTGRESQL" title="Blast radius" />
          <div className="impact-flow">
            <div className="impact-origin">
              <span>3</span>
              <b>changed files</b>
            </div>
            <div className="impact-branch">
              <i />
              <div>
                <span>2</span>
                <b>public routes</b>
                {impact.routes.map((route) => (
                  <code key={route}>{route}</code>
                ))}
              </div>
              <div>
                <span>7</span>
                <b>downstream entities</b>
                <code>AuthController.login</code>
                <code>AuthService.authenticate</code>
              </div>
              <div>
                <span>3</span>
                <b>recommended tests</b>
                <code>AuthServiceTest</code>
                <code>LoginControllerTest</code>
              </div>
            </div>
          </div>
          <div className="truncation-note">
            Result bounded to depth 3 · 12 of maximum 200 nodes · not truncated
          </div>
        </Panel>
        <Panel className="span-5">
          <PanelHeader eyebrow="EXPLAINABLE SCORE" title="Risk factors" />
          <div className="risk-meter">
            <span style={{ width: `${impact.risk}%` }} />
          </div>
          <div className="factor-list">
            {impact.factors.map(([factor, weight]) => (
              <div key={factor}>
                <span>{factor}</span>
                <strong>{weight}</strong>
              </div>
            ))}
          </div>
          <p className="inference-note">
            Risk is rule-based. No model was used to assign this score.
          </p>
        </Panel>
        <Panel className="span-7">
          <PanelHeader eyebrow="TEST IMPACT" title="Recommended verification" />
          {impact.tests.map(([test, reason, confidence]) => (
            <div className="test-row" key={test}>
              <span>◆</span>
              <div>
                <strong>{test}</strong>
                <p>{reason}</p>
              </div>
              <Confidence level={confidence} />
            </div>
          ))}
        </Panel>
        <Panel className="span-5">
          <PanelHeader eyebrow="REVIEW FOCUS" title="What deserves attention" />
          <ol className="review-list">
            <li>
              <span>01</span>Confirm refresh tokens are not affected by the shorter access-token
              expiry.
            </li>
            <li>
              <span>02</span>Review authentication failures across both public endpoints.
            </li>
            <li>
              <span>03</span>Update the documented token lifetime before merge.
            </li>
          </ol>
          <SourceRef>Impact path: 12 entities / depth 3</SourceRef>
        </Panel>
      </div>
    </>
  );
}
