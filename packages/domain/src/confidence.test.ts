import { describe, expect, it } from "vitest";

import { createConfidence } from "./confidence.js";

describe("createConfidence", () => {
  it.each([
    ["confirmed", 1],
    ["inferred", 0.85],
    ["tentative", 0.4],
  ] as const)("accepts %s confidence in its score range", (level, score) => {
    expect(createConfidence({ level, reason: "fixture evidence", score })).toEqual({
      level,
      reason: "fixture evidence",
      score,
    });
  });

  it.each([
    ["confirmed", 0.94],
    ["inferred", 0.49],
    ["inferred", 0.95],
    ["tentative", 0.5],
  ] as const)("rejects %s confidence outside its score range", (level, score) => {
    expect(() => createConfidence({ level, reason: "fixture evidence", score })).toThrow(
      "confidence score",
    );
  });

  it("rejects an empty reason or non-finite score", () => {
    expect(() => createConfidence({ level: "confirmed", reason: " ", score: 1 })).toThrow("reason");
    expect(() =>
      createConfidence({ level: "tentative", reason: "fixture evidence", score: Number.NaN }),
    ).toThrow("finite");
  });
});
