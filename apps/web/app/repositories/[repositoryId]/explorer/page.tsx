import { graphEdges, graphNodes } from "../../../../lib/demo-data";
import { Confidence, PageIntro, Panel, PanelHeader, SourceRef } from "../../../../components/ui";

export default function ExplorerPage() {
  return (
    <>
      <PageIntro
        eyebrow="02 / EXPLORER"
        title="Follow the evidence"
        summary="Search canonical entities and expand a bounded neighborhood. The graph never renders the whole repository at once."
      />
      <div className="explorer-toolbar">
        <label>
          <span>SEARCH ENTITY</span>
          <input defaultValue="POST /api/login" />
        </label>
        <label>
          <span>DIRECTION</span>
          <select defaultValue="both">
            <option>both</option>
            <option>incoming</option>
            <option>outgoing</option>
          </select>
        </label>
        <label>
          <span>DEPTH</span>
          <select defaultValue="3">
            <option>1</option>
            <option>2</option>
            <option>3</option>
          </select>
        </label>
        <button type="button">RUN QUERY →</button>
      </div>
      <div className="explorer-layout">
        <Panel className="entity-results">
          <PanelHeader eyebrow="6 MATCHES" title="Entities" />
          {graphNodes.map((node, index) => (
            <button
              className={index === 0 ? "entity-row selected" : "entity-row"}
              key={node.id}
              type="button"
            >
              <span className={`entity-kind kind-${node.kind}`}>
                {node.kind.slice(0, 2).toUpperCase()}
              </span>
              <div>
                <strong>{node.label}</strong>
                <small>{node.kind} · java</small>
              </div>
              <span>›</span>
            </button>
          ))}
        </Panel>
        <Panel className="graph-panel">
          <PanelHeader
            eyebrow="POSTGRESQL TRAVERSAL · 6 / 200 NODES"
            title="Neighborhood"
            action={<span className="bounded-badge">BOUNDED</span>}
          />
          <div className="graph-canvas">
            <svg className="graph-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
              {graphEdges.map((edge) => {
                const from = graphNodes.find((node) => node.id === edge.from);
                const to = graphNodes.find((node) => node.id === edge.to);
                return from && to ? (
                  <line
                    key={`${edge.from}-${edge.to}`}
                    x1={from.x + 8}
                    x2={to.x + 8}
                    y1={from.y + 4}
                    y2={to.y + 4}
                  />
                ) : null;
              })}
            </svg>
            {graphNodes.map((node) => (
              <button
                className={`graph-node kind-${node.kind}`}
                key={node.id}
                style={{ left: `${node.x}%`, top: `${node.y}%` }}
                type="button"
              >
                <span>{node.kind}</span>
                <strong>{node.label}</strong>
              </button>
            ))}
            <div className="graph-legend">
              {graphEdges.map((edge) => (
                <span key={`${edge.from}-${edge.to}`}>{edge.label}</span>
              ))}
            </div>
          </div>
        </Panel>
        <Panel className="evidence-drawer">
          <PanelHeader eyebrow="SELECTED ENTITY" title="POST /api/login" />
          <dl>
            <dt>Kind</dt>
            <dd>endpoint</dd>
            <dt>Framework</dt>
            <dd>Spring Boot</dd>
            <dt>Confidence</dt>
            <dd>
              <Confidence level="high" />
            </dd>
            <dt>Stable key</dt>
            <dd>
              <code>endpoint:POST:/api/login</code>
            </dd>
          </dl>
          <h3>Source evidence</h3>
          <SourceRef>AuthController.java:31–47</SourceRef>
          <pre className="code-snippet">
            <code>
              <mark>@PostMapping(&quot;/api/login&quot;)</mark>
              {"\n"}public TokenResponse login(...) &#123;{"\n"} return
              authService.authenticate(...);{"\n"}&#125;
            </code>
          </pre>
        </Panel>
      </div>
    </>
  );
}
