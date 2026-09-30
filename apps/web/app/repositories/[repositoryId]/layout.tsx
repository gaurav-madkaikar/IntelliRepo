import type { ReactNode } from "react";

import { RepositoryShell } from "../../../components/repository-shell";
import { ProductErrorState } from "../../../components/product-error-state";
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
    <RepositoryShell
      {...(data.mode === "live" ? { overview: data.overview } : {})}
      repositoryId={repositoryId}
    >
      {data.mode === "live" ? children : <ProductErrorState reason={data.reason} />}
    </RepositoryShell>
  );
}
