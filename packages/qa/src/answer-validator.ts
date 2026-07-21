import type { EvidencePack, EvidenceReference } from "./qa-model.js";

export interface GeneratedAnswerCandidate {
  readonly answer: string;
  readonly citationIds: readonly string[];
  readonly inferred: boolean;
}

export interface ValidatedGeneratedAnswer {
  readonly answer: string;
  readonly citations: readonly EvidenceReference[];
  readonly inferred: boolean;
  readonly valid: boolean;
}

export function validateGeneratedAnswer(
  candidate: GeneratedAnswerCandidate,
  evidence: EvidencePack,
): ValidatedGeneratedAnswer {
  const references = new Map(evidence.references.map((reference) => [reference.id, reference]));
  const citationIds = [...new Set(candidate.citationIds)].filter((id) => references.has(id));
  const answer = candidate.answer.replace(/\[([^\]]+)\]/gu, (token, id: string) =>
    references.has(id) ? token : "",
  );
  const citedInAnswer = [...answer.matchAll(/\[([^\]]+)\]/gu)].map((match) => match[1] as string);
  const allIds = [...new Set([...citationIds, ...citedInAnswer])].filter((id) =>
    references.has(id),
  );
  return {
    answer: answer.trim(),
    citations: allIds.map((id) => references.get(id) as EvidenceReference),
    inferred: candidate.inferred,
    valid: answer.trim().length > 0 && (evidence.references.length === 0 || allIds.length > 0),
  };
}
