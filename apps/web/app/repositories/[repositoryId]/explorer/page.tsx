import { LiveGraphExplorer } from "../../../../components/live-graph-explorer";
import { PageIntro } from "../../../../components/ui";

export default async function ExplorerPage({
  params,
}: {
  readonly params: Promise<{ repositoryId: string }>;
}) {
  const { repositoryId } = await params;
  return (
    <>
      <PageIntro
        eyebrow="02 / EXPLORER"
        title="Follow the evidence"
        summary="Search canonical entities and expand a bounded PostgreSQL neighborhood. The graph never renders the whole repository at once."
      />
      <LiveGraphExplorer repositoryId={repositoryId} />
    </>
  );
}
