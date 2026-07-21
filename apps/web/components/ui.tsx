import Link from "next/link";
import type { ReactNode } from "react";

export function StatusDot({ state }: { readonly state: string }) {
  return <span aria-label={state} className={`status-dot status-${state}`} />;
}

export function Panel({
  children,
  className = "",
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <section className={`panel ${className}`}>{children}</section>;
}

export function PanelHeader({
  action,
  eyebrow,
  title,
}: {
  readonly action?: ReactNode;
  readonly eyebrow?: string;
  readonly title: string;
}) {
  return (
    <header className="panel-header">
      <div>
        {eyebrow === undefined ? null : <span className="micro-label">{eyebrow}</span>}
        <h2>{title}</h2>
      </div>
      {action}
    </header>
  );
}

export function Confidence({ level }: { readonly level: string }) {
  return <span className={`confidence confidence-${level}`}>{level} confidence</span>;
}

export function SourceRef({ children }: { readonly children: ReactNode }) {
  return (
    <button className="source-ref" type="button">
      ⌁ {children}
    </button>
  );
}

export function PageIntro({
  eyebrow,
  title,
  summary,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly summary: string;
}) {
  return (
    <div className="page-intro">
      <span className="page-index">{eyebrow}</span>
      <div>
        <h1>{title}</h1>
        <p>{summary}</p>
      </div>
    </div>
  );
}

export function ArrowLink({
  children,
  href,
}: {
  readonly children: ReactNode;
  readonly href: string;
}) {
  return (
    <Link className="arrow-link" href={href}>
      {children}
      <span>↗</span>
    </Link>
  );
}
