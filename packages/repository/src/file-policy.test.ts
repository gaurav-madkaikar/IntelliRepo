import { describe, expect, it } from "vitest";

import { FilePolicy } from "./file-policy.js";

describe("FilePolicy", () => {
  const policy = new FilePolicy(100);

  it.each([
    ["src/main/java/User.java", "code", "java"],
    ["src/test/kotlin/UserTest.kt", "test", "kotlin"],
    ["src/user.spec.ts", "test", "typescript"],
    ["docs/onboarding.md", "documentation", undefined],
    ["build.gradle.kts", "build", undefined],
    ["application.yml", "configuration", undefined],
  ] as const)("classifies %s", (path, artifactKind, language) => {
    const decision = policy.evaluate({ path, sizeBytes: 10 });
    expect(decision).toMatchObject({
      artifactKind,
      supported: true,
    });
    if (!decision.supported) {
      throw new Error(`Expected ${path} to be supported`);
    }
    expect(decision.language).toBe(language);
  });

  it.each([
    ["node_modules/library/index.ts", "generated"],
    [".env", "environment-secret"],
    ["src/image.ts", "oversized"],
    ["assets/logo.png", "unsupported"],
  ] as const)("skips %s with %s diagnostics", (path, reason) => {
    const sizeBytes = reason === "oversized" ? 101 : 10;
    expect(policy.evaluate({ path, sizeBytes })).toMatchObject({ reason, supported: false });
  });

  it("detects a binary prefix before extension-based classification", () => {
    expect(
      policy.evaluate({
        contentPrefix: Uint8Array.from([1, 0, 2]),
        path: "src/binary.ts",
        sizeBytes: 3,
      }),
    ).toMatchObject({ reason: "binary", supported: false });
  });
});
