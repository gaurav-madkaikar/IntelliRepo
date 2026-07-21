import Link from "next/link";
import type { ReactNode } from "react";

import { capabilityData, demoRepository } from "../lib/demo-data";
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
  dataMode,
  repositoryId,
}: {
  readonly children: ReactNode;
  readonly dataMode: "live" | "portfolio";
  readonly repositoryId: string;
}) {
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
          <strong>{demoRepository.name}</strong>
          <span>
            {demoRepository.branch} · {demoRepository.revision}
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
          {capabilityData.map((item) => (
            <div key={item.label}>
              <StatusDot state={item.state} />
              <span>{item.label}</span>
              <small>{item.lag}</small>
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
            <strong>{demoRepository.name}</strong>
          </div>
          <div className="top-actions">
            <span className={`demo-chip data-${dataMode}`}>
              {dataMode === "live" ? "LIVE API" : "PORTFOLIO FALLBACK"}
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
