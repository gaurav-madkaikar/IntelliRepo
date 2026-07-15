import { execFileSync } from "node:child_process";
import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FilePolicy } from "./file-policy.js";
import { GitChangeDetector, gitNameStatusParserForTesting } from "./git-change-detector.js";
import { LocalRepositoryAdapter } from "./local-repository-adapter.js";

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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fileSystem.rm(directory, { force: true, recursive: true })),
  );
});

describe("LocalRepositoryAdapter", () => {
  it("registers a repository contained by an allowed root and inventories supported files", async () => {
    const allowedRoot = await temporaryDirectory("intellirepo-allowed-");
    const repositoryRoot = await createRepository(allowedRoot);
    await fileSystem.writeFile(
      join(repositoryRoot, "src", "index.ts"),
      "export const value = 1;\n",
    );
    await fileSystem.writeFile(join(repositoryRoot, "README.md"), "# Fixture\n");
    await fileSystem.writeFile(join(repositoryRoot, "binary.ts"), Buffer.from([1, 0, 2]));
    git(repositoryRoot, "add", ".");
    git(repositoryRoot, "commit", "-m", "fixture");

    const adapter = new LocalRepositoryAdapter([allowedRoot], new FilePolicy(1_024));
    const registered = await adapter.register(join(repositoryRoot, "src"));
    const inventory = await adapter.inventory(repositoryRoot);

    expect(registered).toMatchObject({
      defaultBranch: "main",
      rootPath: await fileSystem.realpath(repositoryRoot),
    });
    expect(inventory.artifacts.map(({ path }) => path).sort()).toEqual([
      "README.md",
      "src/index.ts",
    ]);
    expect(inventory.diagnostics).toEqual([
      expect.objectContaining({ decision: expect.objectContaining({ reason: "binary" }) }),
    ]);
  });

  it("rejects repositories outside configured roots and escaping symlinks", async () => {
    const allowedRoot = await temporaryDirectory("intellirepo-allowed-");
    const outsideRoot = await temporaryDirectory("intellirepo-outside-");
    const repositoryRoot = await createRepository(outsideRoot);
    await fileSystem.writeFile(join(repositoryRoot, "src", "index.ts"), "export {};\n");
    git(repositoryRoot, "add", ".");
    git(repositoryRoot, "commit", "-m", "fixture");

    const adapter = new LocalRepositoryAdapter([allowedRoot], new FilePolicy(1_024));
    await expect(adapter.register(repositoryRoot)).rejects.toThrow("outside configured roots");

    const allowedRepository = await createRepository(allowedRoot);
    const outsideFile = join(outsideRoot, "outside.ts");
    await fileSystem.writeFile(outsideFile, "export const secret = true;\n");
    await fileSystem.symlink(outsideFile, join(allowedRepository, "src", "escape.ts"));
    await expect(adapter.resolveArtifactPath(allowedRepository, "src/escape.ts")).rejects.toThrow(
      "escapes repository root",
    );
  });
});

describe("GitChangeDetector", () => {
  it("parses NUL-delimited name-status output including copies", () => {
    const changes = gitNameStatusParserForTesting.parse(
      Buffer.from("M\0src/a.ts\0R100\0src/old.ts\0src/new.ts\0C100\0src/a.ts\0src/copy.ts\0"),
    );

    expect(changes).toEqual([
      { currentPath: "src/a.ts", previousPath: "src/a.ts", status: "modified" },
      { currentPath: "src/new.ts", previousPath: "src/old.ts", status: "renamed" },
      { currentPath: "src/copy.ts", status: "added" },
    ]);
  });

  it("detects added, modified, deleted, and renamed supported files", async () => {
    const parent = await temporaryDirectory("intellirepo-git-");
    const repositoryRoot = await createRepository(parent);
    await fileSystem.writeFile(join(repositoryRoot, ".gitignore"), "ignored.ts\n");
    await fileSystem.writeFile(join(repositoryRoot, "src", "rename.ts"), "export const a = 1;\n");
    await fileSystem.writeFile(join(repositoryRoot, "src", "modify.ts"), "export const b = 1;\n");
    await fileSystem.writeFile(join(repositoryRoot, "src", "delete.ts"), "export const c = 1;\n");
    git(repositoryRoot, "add", ".");
    git(repositoryRoot, "commit", "-m", "initial");
    const baseRevision = git(repositoryRoot, "rev-parse", "HEAD");

    await fileSystem.rename(
      join(repositoryRoot, "src", "rename.ts"),
      join(repositoryRoot, "src", "renamed.ts"),
    );
    await fileSystem.writeFile(join(repositoryRoot, "src", "modify.ts"), "export const b = 2;\n");
    await fileSystem.rm(join(repositoryRoot, "src", "delete.ts"));
    await fileSystem.writeFile(join(repositoryRoot, "src", "added.ts"), "export const d = 1;\n");
    await fileSystem.writeFile(join(repositoryRoot, "ignored.ts"), "ignored\n");

    const detector = new GitChangeDetector(new FilePolicy(1_024));
    const result = await detector.detect({
      baseRevision,
      repositoryId: "repository-1",
      repositoryRoot,
    });

    expect(result.changeSet.changes.map(({ kind }) => kind).sort()).toEqual([
      "added",
      "deleted",
      "modified",
      "renamed",
    ]);
    expect(result.changeSet.changes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ current: expect.objectContaining({ path: "ignored.ts" }) }),
      ]),
    );
  });

  it("changes the worktree fingerprint when tracked content changes", async () => {
    const parent = await temporaryDirectory("intellirepo-fingerprint-");
    const repositoryRoot = await createRepository(parent);
    const path = join(repositoryRoot, "src", "index.ts");
    await fileSystem.writeFile(path, "export const value = 1;\n");
    git(repositoryRoot, "add", ".");
    git(repositoryRoot, "commit", "-m", "initial");
    const detector = new GitChangeDetector(new FilePolicy(1_024));
    const clean = await detector.fingerprintWorkingTree(repositoryRoot);

    await fileSystem.writeFile(path, "export const value = 2;\n");
    const changed = await detector.fingerprintWorkingTree(repositoryRoot);

    expect(changed).not.toBe(clean);
  });
});
