import Link from "next/link";

import { demoRepository } from "../lib/demo-data";

const terminal = [
  "$ intellirepo scan ./sample-auth-service",
  "",
  "✓ 438 files inventoried",
  "✓ 1,284 entities committed",
  "✓ 2,941 relationships resolved",
  "✓ 24 API routes discovered",
  "! 3 documentation findings",
  "",
  "CANONICAL  postgres / 9f2c71a",
  "TRAVERSAL  postgresql fallback",
  "MODEL      offline / deterministic mode",
  "",
  "READY  00:07.82",
].join("\n");

export default function HomePage() {
  return (
    <main className="landing">
      <div className="landing-grid">
        <div className="landing-copy">
          <p className="eyebrow">LOCAL-FIRST / EVIDENCE-BACKED</p>
          <h1>
            READ THE
            <br />
            <i>REAL</i> REPO.
          </h1>
          <p>
            IntelliRepo turns source, relationships, tests, and documentation into a revision-aware
            intelligence layer—without requiring your code to leave the machine.
          </p>
          <Link className="primary-cta" href={`/repositories/${demoRepository.id}/overview`}>
            OPEN CONTROL ROOM <span>→</span>
          </Link>
        </div>
        <div className="landing-terminal">
          <div className="terminal-bar">
            <span />
            <span />
            <span />
            <b>INDEX / {demoRepository.name}</b>
          </div>
          <pre>{terminal}</pre>
        </div>
      </div>
      <footer>
        <span>POSTGRESQL CANONICAL</span>
        <span>PGVECTOR SELECTIVE</span>
        <span>NEO4J OPTIONAL</span>
        <span>OLLAMA LOCAL</span>
      </footer>
    </main>
  );
}
