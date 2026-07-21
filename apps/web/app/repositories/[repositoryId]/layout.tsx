import type { ReactNode } from "react";

import { RepositoryShell } from "../../../components/repository-shell";
import { loadDashboardData } from "../../../lib/product-api";

export default async function RepositoryLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ repositoryId: string }>;
}) {
  const { repositoryId } = await params;
  const data = await loadDashboardData(repositoryId);
  return (
    <RepositoryShell dataMode={data.mode} repositoryId={repositoryId}>
      {children}
    </RepositoryShell>
  );
}
