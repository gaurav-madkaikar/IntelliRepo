import Link from "next/link";
import type { ReactNode } from "react";
import type { RepositoryOverviewResponse } from "@intellirepo/contracts";

import { StatusDot } from "./ui";

const navigation = [
  ["01", "Overview", "overview"],
  ["02", "Explorer", "explorer"],
  ["03", "Doc health", "documentation-health"],
  ["04", "Impact", "impact"],
  ["05", "Documentation", "documentation"],
  ["06", "Ask", "ask"],
] as const;

export function RepositoryShell({
  children,
  overview,
  repositoryId,
}: {
  readonly children: ReactNode;
  readonly overview?: RepositoryOverviewResponse;
  readonly repositoryId: string;
}) {
  const repositoryName = overview?.repository.displayName ?? repositoryId;
  const capabilities =
    overview === undefined
      ? []
      : ([
          ["PostgreSQL", overview.capabilities.canonical],
          ["pgvector", overview.capabilities.semantic],
          ["Analysis", overview.capabilities.analysis],
          ["Ollama", overview.capabilities.ollama],
          ["Dispatch", overview.capabilities.worker],
        ] as const);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/">
          <span className="brand-mark">IR</span>
          <span>
            INTELLI<em>REPO</em>
          </span>
        </Link>
        <div className="repo-switcher">
          <span className="micro-label">Active repository</span>
          <strong>{repositoryName}</strong>
          <span>
            {overview?.repository.defaultBranch ?? "unregistered"} ·{" "}
            {overview?.revision?.commitSha.slice(0, 8) ?? "no active revision"}
          </span>
        </div>
        <nav aria-label="Repository navigation">
          {navigation.map(([index, label, path]) => (
            <Link href={`/repositories/${repositoryId}/${path}`} key={path}>
              <span>{index}</span>
              {label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-status">
          <span className="micro-label">System matrix</span>
          {capabilities.map(([label, capability]) => (
            <div key={label}>
              <StatusDot state={capability.state} />
              <span>{label}</span>
              <small>{capability.lagRevisions} rev</small>
            </div>
          ))}
        </div>
        <div className="local-badge">
          <StatusDot state="current" />
          <div>
            <strong>LOCAL MODE</strong>
            <span>No source leaves this machine</span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span>REPOSITORIES</span>
            <b>/</b>
            <strong>{repositoryName}</strong>
          </div>
          <div className="top-actions">
            <span className={`demo-chip data-${overview === undefined ? "error" : "live"}`}>
              {overview === undefined ? "LIVE API ERROR" : "LIVE API"}
            </span>
            <button type="button">⌘ K</button>
            <div className="avatar">GM</div>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
