import { AskConsole } from "../../../../components/ask-console";
import { PageIntro } from "../../../../components/ui";

export default function AskPage() {
  return (
    <>
      <PageIntro
        eyebrow="06 / ASK"
        title="Question the graph"
        summary="Answers are revision-scoped, citation-validated, and explicit about inference or unavailable model capabilities."
      />
      <AskConsole />
    </>
  );
}
