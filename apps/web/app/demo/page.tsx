import Link from "next/link";

import { capabilityData, demoRepository, findings, metrics } from "../../lib/demo-data";
import { Panel, PanelHeader, StatusDot } from "../../components/ui";

export default function DemoPage() {
  return (
    <main className="fixture-demo">
      <header>
        <div>
          <span>FIXTURE / OFFLINE WALKTHROUGH</span>
          <h1>IntelliRepo evidence room</h1>
          <p>
            This route is intentionally fixture-backed and remains available with the API stopped.
            It is not presented as a live repository scan.
          </p>
        </div>
        <Link href="/">EXIT DEMO →</Link>
      </header>
      <div className="demo-banner">
        DEMO DATA · {demoRepository.name} · revision {demoRepository.revision}
      </div>
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
        <Panel className="span-7">
          <PanelHeader eyebrow="CAPABILITY STORY" title="Graceful degradation" />
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
        </Panel>
        <Panel className="span-5">
          <PanelHeader
            eyebrow="STALE DOCUMENTATION"
            title={`${findings.length} explainable findings`}
          />
          <div className="fixture-findings">
            {findings.map((finding) => (
              <article key={finding.id}>
                <b>{finding.id}</b>
                <strong>{finding.kind}</strong>
                <p>{finding.detail}</p>
              </article>
            ))}
          </div>
        </Panel>
      </div>
    </main>
  );
}
