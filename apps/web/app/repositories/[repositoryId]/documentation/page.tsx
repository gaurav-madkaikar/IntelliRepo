import { diffLines } from "../../../../lib/demo-data";
import { PageIntro, Panel, PanelHeader, SourceRef } from "../../../../components/ui";

export default function DocumentationPage() {
  return (
    <>
      <PageIntro
        eyebrow="05 / DOCUMENTATION"
        title="Review before write"
        summary="Generated Markdown stays a reviewable proposal. Apply only after inspecting facts, source references, and the local diff."
      />
      <div className="document-toolbar">
        <div>
          <span>TARGET FILE</span>
          <code>docs/authentication.md</code>
        </div>
        <div>
          <span>GENERATED FROM</span>
          <code>revision 9f2c71a</code>
        </div>
        <span className="ai-state">AI ENHANCEMENT: DISABLED</span>
        <button type="button">APPLY ACCEPTED DIFF →</button>
      </div>
      <div className="documentation-layout">
        <Panel className="doc-tree">
          <PanelHeader eyebrow="WORKSPACE" title="Documentation" />
          <ul>
            <li className="folder">
              ▾ docs
              <ul>
                <li className="selected">
                  authentication.md <span>M</span>
                </li>
                <li>onboarding.md</li>
                <li className="folder">
                  ▸ api <span>1</span>
                </li>
                <li className="folder">▸ modules</li>
              </ul>
            </li>
          </ul>
          <div className="manifest">
            <span>MANIFEST</span>
            <p>
              5 entities
              <br />4 relationships
              <br />3 source references
            </p>
          </div>
        </Panel>
        <Panel className="diff-panel">
          <PanelHeader
            eyebrow="PENDING REVIEW · DOC-014"
            title="Local Markdown diff"
            action={
              <div className="diff-count">
                <b>+2</b>
                <span>−1</span>
              </div>
            }
          />
          <div className="diff-file">
            <div className="diff-file-header">
              <span>docs/authentication.md</span>
              <small>@@ -28,5 +28,6 @@</small>
            </div>
            {diffLines.map((line, index) => (
              <div className={`diff-line diff-${line.kind}`} key={`${line.kind}-${index}`}>
                <span>{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span>
                <code>{line.text || " "}</code>
              </div>
            ))}
          </div>
          <div className="source-strip">
            <span>SOURCES</span>
            <SourceRef>application.yml:42</SourceRef>
            <SourceRef>JwtTokenProvider.java:28–46</SourceRef>
          </div>
        </Panel>
        <Panel className="review-panel">
          <PanelHeader eyebrow="SAFETY GATES" title="Apply checklist" />
          <label>
            <input defaultChecked type="checkbox" /> Claim matches canonical configuration
          </label>
          <label>
            <input defaultChecked type="checkbox" /> Source references resolve
          </label>
          <label>
            <input type="checkbox" /> Human wording review complete
          </label>
          <div className="checksum">
            <span>CURRENT CHECKSUM</span>
            <code>sha256:7a1c…e91f</code>
          </div>
          <p>The apply will fail if this file changes after preview.</p>
        </Panel>
      </div>
    </>
  );
}
