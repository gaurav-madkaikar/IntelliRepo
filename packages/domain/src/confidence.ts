export const CONFIDENCE_LEVELS = ["confirmed", "inferred", "tentative"] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export interface Confidence {
  readonly level: ConfidenceLevel;
  readonly reason: string;
  readonly score: number;
}

export interface CreateConfidenceInput {
  readonly level: ConfidenceLevel;
  readonly reason: string;
  readonly score: number;
}

const scoreRanges: Readonly<Record<ConfidenceLevel, readonly [minimum: number, maximum: number]>> =
  {
    confirmed: [0.95, 1],
    inferred: [0.5, 0.95],
    tentative: [0, 0.5],
  };

export function createConfidence(input: CreateConfidenceInput): Confidence {
  const reason = input.reason.trim();

  if (reason.length === 0) {
    throw new Error("Confidence reason must not be empty");
  }

  if (!Number.isFinite(input.score)) {
    throw new Error("Confidence score must be a finite number");
  }

  const [minimum, maximum] = scoreRanges[input.level];
  const upperBoundIsInclusive = input.level === "confirmed";
  const isWithinRange =
    input.score >= minimum &&
    (upperBoundIsInclusive ? input.score <= maximum : input.score < maximum);

  if (!isWithinRange) {
    const bracket = upperBoundIsInclusive ? "]" : ")";
    throw new Error(`${input.level} confidence score must be in [${minimum}, ${maximum}${bracket}`);
  }

  return Object.freeze({
    level: input.level,
    reason,
    score: input.score,
  });
}
