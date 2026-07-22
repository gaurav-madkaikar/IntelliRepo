import { execFileSync } from "node:child_process";
import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FilePolicy } from "./file-policy.js";
import { GitChangeDetector } from "./git-change-detector.js";
import { LocalRepositoryAdapter } from "./local-repository-adapter.js";
import { RepositorySnapshotBuilder, StaleRepositorySnapshotError } from "./repository-snapshot.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fileSystem.mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(repositoryRoot: string, ...arguments_: string[]): string {
  return execFileSync("git", ["-C", repositoryRoot, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function createRepository(parent: string): Promise<string> {
  const repositoryRoot = join(parent, "fixture-repository");
  await fileSystem.mkdir(join(repositoryRoot, "src"), { recursive: true });
  git(repositoryRoot, "init", "-b", "main");
  git(repositoryRoot, "config", "user.name", "IntelliRepo Test");
  git(repositoryRoot, "config", "user.email", "intellirepo@example.invalid");
  return repositoryRoot;
}

function snapshotBuilder(allowedRoot: string, maxFileBytes = 1_024) {
  const policy = new FilePolicy(maxFileBytes);
  return {
    adapter: new LocalRepositoryAdapter([allowedRoot], policy),
    builder: new RepositorySnapshotBuilder(
      new LocalRepositoryAdapter([allowedRoot], policy),
      new GitChangeDetector(policy),
      () => new Date("2026-07-22T00:00:00.000Z"),
    ),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fileSystem.rm(directory, { force: true, recursive: true })),
  );
});

describe("RepositorySnapshotBuilder", () => {
  it("captures an initial UTF-8 snapshot and reports unsafe files without aborting", async () => {
    const allowedRoot = await temporaryDirectory("intellirepo-snapshot-initial-");
    const outsideRoot = await temporaryDirectory("intellirepo-snapshot-outside-");
    const repositoryRoot = await createRepository(allowedRoot);
    await fileSystem.writeFile(join(repositoryRoot, ".gitignore"), "ignored.ts\n");
    await fileSystem.writeFile(join(repositoryRoot, "README.md"), "# Fixture\n");
    await fileSystem.writeFile(
      join(repositoryRoot, "src", "index.ts"),
      "export const value = 1;\n",
    );
    await fileSystem.writeFile(join(repositoryRoot, "src", "binary.java"), Buffer.from([1, 0, 2]));
    await fileSystem.writeFile(
      join(repositoryRoot, "src", "invalid.ts"),
      Buffer.from([0xc3, 0x28]),
    );
    await fileSystem.writeFile(join(repositoryRoot, "src", "oversized.ts"), "x".repeat(80));
    git(repositoryRoot, "add", ".");
    git(repositoryRoot, "commit", "-m", "initial");
    await fileSystem.writeFile(join(repositoryRoot, "ignored.ts"), "ignored\n");
    const outsideFile = join(outsideRoot, "outside.ts");
    await fileSystem.writeFile(outsideFile, "export const outside = true;\n");
    await fileSystem.symlink(outsideFile, join(repositoryRoot, "src", "escape.ts"));

    const { adapter, builder } = snapshotBuilder(allowedRoot, 64);
    const repository = await adapter.register(repositoryRoot);
    const snapshot = await builder.capture({ repository });

    expect(snapshot.artifacts.map(({ path }) => path).sort()).toEqual([
      "README.md",
      "src/index.ts",
    ]);
    expect(snapshot.changeSet.changes).toHaveLength(2);
    expect(snapshot.diagnostics.map(({ reason }) => reason)).toEqual(
      expect.arrayContaining([
        "binary",
        "ignored",
        "invalid-utf8",
        "oversized",
        "symlink-escape",
        "unsupported",
      ]),
    );
    expect(snapshot.clean).toBe(false);
    expect(snapshot.capturedAt).toBe("2026-07-22T00:00:00.000Z");
  }, 20_000);

  it("loads only added, modified, and renamed destinations for an incremental snapshot", async () => {
    const allowedRoot = await temporaryDirectory("intellirepo-snapshot-incremental-");
    const repositoryRoot = await createRepository(allowedRoot);
    for (const [name, content] of [
      ["delete.ts", "export const deleted = 1;\n"],
      ["modify.ts", "export const modified = 1;\n"],
      ["rename.ts", "export const renamed = 1;\n"],
      ["unchanged.ts", "export const unchanged = 1;\n"],
    ] as const) {
      await fileSystem.writeFile(join(repositoryRoot, "src", name), content);
    }
    git(repositoryRoot, "add", ".");
    git(repositoryRoot, "commit", "-m", "initial");
    const baseRevision = git(repositoryRoot, "rev-parse", "HEAD");
    await fileSystem.rm(join(repositoryRoot, "src", "delete.ts"));
    await fileSystem.writeFile(
      join(repositoryRoot, "src", "modify.ts"),
      "export const modified = 2;\n",
    );
    await fileSystem.rename(
      join(repositoryRoot, "src", "rename.ts"),
      join(repositoryRoot, "src", "renamed.ts"),
    );
    await fileSystem.writeFile(
      join(repositoryRoot, "src", "added.ts"),
      "export const added = 1;\n",
    );

    const { adapter, builder } = snapshotBuilder(allowedRoot);
    const repository = await adapter.register(repositoryRoot);
    const snapshot = await builder.capture({ baseRevision, repository });

    expect(snapshot.changeSet.changes.map(({ kind }) => kind).sort()).toEqual([
      "added",
      "deleted",
      "modified",
      "renamed",
    ]);
    expect(snapshot.artifacts.map(({ path }) => path).sort()).toEqual([
      "src/added.ts",
      "src/modify.ts",
      "src/renamed.ts",
    ]);
    expect(snapshot.artifacts.map(({ path }) => path)).not.toContain("src/unchanged.ts");
  }, 20_000);

  it("rejects activation when repository content changes after capture", async () => {
    const allowedRoot = await temporaryDirectory("intellirepo-snapshot-stale-");
    const repositoryRoot = await createRepository(allowedRoot);
    const sourcePath = join(repositoryRoot, "src", "index.ts");
    await fileSystem.writeFile(sourcePath, "export const value = 1;\n");
    git(repositoryRoot, "add", ".");
    git(repositoryRoot, "commit", "-m", "initial");

    const { adapter, builder } = snapshotBuilder(allowedRoot);
    const repository = await adapter.register(repositoryRoot);
    const snapshot = await builder.capture({ repository });
    await fileSystem.writeFile(sourcePath, "export const value = 2;\n");

    await expect(builder.assertCurrent(snapshot)).rejects.toMatchObject({
      code: "STALE_REPOSITORY_SNAPSHOT",
      name: StaleRepositorySnapshotError.name,
    });
  }, 20_000);
});
