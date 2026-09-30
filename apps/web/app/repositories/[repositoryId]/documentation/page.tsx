import { LiveDocumentationReview } from "../../../../components/live-documentation-review";
import { PageIntro } from "../../../../components/ui";

export default async function DocumentationPage({
  params,
}: {
  readonly params: Promise<{ repositoryId: string }>;
}) {
  const { repositoryId } = await params;
  return (
    <>
      <PageIntro
        eyebrow="05 / DOCUMENTATION"
        title="Review before write"
        summary="Generated Markdown stays a durable, reviewable proposal. Apply only after inspecting facts, source references, and the local diff."
      />
      <LiveDocumentationReview repositoryId={repositoryId} />
    </>
  );
}
