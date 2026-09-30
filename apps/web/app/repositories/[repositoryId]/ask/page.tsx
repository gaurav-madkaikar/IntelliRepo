import { AskConsole } from "../../../../components/ask-console";
import { PageIntro } from "../../../../components/ui";

export default async function AskPage({
  params,
}: {
  readonly params: Promise<{ repositoryId: string }>;
}) {
  const { repositoryId } = await params;
  return (
    <>
      <PageIntro
        eyebrow="06 / ASK"
        title="Question the graph"
        summary="Answers are revision-scoped, citation-validated, and explicit about inference or unavailable model capabilities."
      />
      <AskConsole repositoryId={repositoryId} />
    </>
  );
}
