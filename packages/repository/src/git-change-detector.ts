import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fileSystem } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createArtifactChange,
  createChangeSet,
  type ArtifactChange,
  type ArtifactState,
  type ChangeSet,
} from "@intellirepo/domain";

import { FilePolicy } from "./file-policy.js";

const execFile = promisify(execFileCallback);

interface NameStatusChange {
  readonly currentPath?: string;
  readonly previousPath?: string;
  readonly status: "added" | "deleted" | "modified" | "renamed";
}

export interface DetectGitChangesInput {
  readonly baseRevision: string;
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly selectedCurrentPaths?: readonly string[];
  readonly targetRevision?: string;
}

export interface GitChangeDiagnostic {
  readonly path: string;
  readonly reason: string;
}

export interface GitChangeDetectionResult {
  readonly changeSet: ChangeSet;
  readonly diagnostics: readonly GitChangeDiagnostic[];
}

async function runGitBuffer(rootPath: string, arguments_: readonly string[]): Promise<Buffer> {
  const { stdout } = await execFile("git", ["-C", rootPath, ...arguments_], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function parseNameStatus(output: Buffer): readonly NameStatusChange[] {
  const tokens = output.toString("utf8").split("\0");
  const changes: NameStatusChange[] = [];

  for (let index = 0; index < tokens.length;) {
    const statusToken = tokens[index++];
    if (statusToken === undefined || statusToken === "") {
      continue;
    }
    const code = statusToken[0];
    const firstPath = tokens[index++];

    if (firstPath === undefined || firstPath === "") {
      throw new Error(`Git emitted an incomplete ${statusToken} change record`);
    }
    if (code === "R") {
      const currentPath = tokens[index++];
      if (currentPath === undefined || currentPath === "") {
        throw new Error("Git emitted an incomplete rename record");
      }
      changes.push({ currentPath, previousPath: firstPath, status: "renamed" });
    } else if (code === "A") {
      changes.push({ currentPath: firstPath, status: "added" });
    } else if (code === "C") {
      const currentPath = tokens[index++];
      if (currentPath === undefined || currentPath === "") {
        throw new Error("Git emitted an incomplete copy record");
      }
      changes.push({ currentPath, status: "added" });
    } else if (code === "D") {
      changes.push({ previousPath: firstPath, status: "deleted" });
    } else if (code === "M" || code === "T") {
      changes.push({ currentPath: firstPath, previousPath: firstPath, status: "modified" });
    }
  }

  return changes;
}

function hash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readRevisionFile(
  repositoryRoot: string,
  revision: string | undefined,
  path: string,
): Promise<Buffer> {
  return revision === undefined
    ? fileSystem.readFile(join(repositoryRoot, path))
    : runGitBuffer(repositoryRoot, ["show", `${revision}:${path}`]);
}

async function artifactState(
  repositoryRoot: string,
  revision: string | undefined,
  path: string,
): Promise<ArtifactState> {
  return { contentHash: hash(await readRevisionFile(repositoryRoot, revision, path)), path };
}

async function coalesceWorktreeRenames(
  repositoryRoot: string,
  baseRevision: string,
  changes: readonly NameStatusChange[],
): Promise<readonly NameStatusChange[]> {
  const addedByHash = new Map<string, NameStatusChange[]>();

  for (const change of changes) {
    if (change.status === "added" && change.currentPath !== undefined) {
      const contentHash = hash(
        await readRevisionFile(repositoryRoot, undefined, change.currentPath),
      );
      const matchingAdds = addedByHash.get(contentHash) ?? [];
      matchingAdds.push(change);
      addedByHash.set(contentHash, matchingAdds);
    }
  }

  const consumed = new Set<NameStatusChange>();
  const renames: NameStatusChange[] = [];
  for (const change of changes) {
    if (change.status !== "deleted" || change.previousPath === undefined) {
      continue;
    }
    const previousHash = hash(
      await readRevisionFile(repositoryRoot, baseRevision, change.previousPath),
    );
    const matchingAdd = addedByHash
      .get(previousHash)
      ?.find((candidate) => !consumed.has(candidate));
    if (matchingAdd?.currentPath !== undefined) {
      consumed.add(change);
      consumed.add(matchingAdd);
      renames.push({
        currentPath: matchingAdd.currentPath,
        previousPath: change.previousPath,
        status: "renamed",
      });
    }
  }

  return [...changes.filter((change) => !consumed.has(change)), ...renames];
}

export class GitChangeDetector {
  public constructor(private readonly filePolicy: FilePolicy) {}

  public async detect(input: DetectGitChangesInput): Promise<GitChangeDetectionResult> {
    const targetRevision = input.targetRevision;
    const diffArguments = [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      input.baseRevision,
      ...(targetRevision === undefined ? [] : [targetRevision]),
      "--",
    ];
    let changes = [...parseNameStatus(await runGitBuffer(input.repositoryRoot, diffArguments))];

    if (targetRevision === undefined) {
      const untracked = (
        await runGitBuffer(input.repositoryRoot, [
          "ls-files",
          "-z",
          "--others",
          "--exclude-standard",
        ])
      )
        .toString("utf8")
        .split("\0")
        .filter((path) => path.length > 0);
      changes.push(...untracked.map((currentPath) => ({ currentPath, status: "added" as const })));
      changes = [
        ...(await coalesceWorktreeRenames(input.repositoryRoot, input.baseRevision, changes)),
      ];
    }

    const artifactChanges: ArtifactChange[] = [];
    const diagnostics: GitChangeDiagnostic[] = [];
    const selectedCurrentPaths =
      input.selectedCurrentPaths === undefined ? undefined : new Set(input.selectedCurrentPaths);

    for (const change of changes) {
      const policyPath = change.currentPath ?? change.previousPath;
      if (policyPath === undefined) {
        continue;
      }

      if (
        change.currentPath !== undefined &&
        selectedCurrentPaths !== undefined &&
        !selectedCurrentPaths.has(change.currentPath)
      ) {
        diagnostics.push({
          path: change.currentPath,
          reason: "Current artifact is outside the safe snapshot selection",
        });
        if (change.status !== "added" && change.previousPath !== undefined) {
          const previousPolicy = this.filePolicy.evaluate({
            path: change.previousPath,
            sizeBytes: 0,
          });
          if (previousPolicy.supported) {
            artifactChanges.push(
              createArtifactChange({
                kind: "deleted",
                previous: await artifactState(
                  input.repositoryRoot,
                  input.baseRevision,
                  change.previousPath,
                ),
              }),
            );
          }
        }
        continue;
      }
      const policy = this.filePolicy.evaluate({ path: policyPath, sizeBytes: 0 });
      if (!policy.supported) {
        diagnostics.push({ path: policyPath, reason: policy.reason });
        continue;
      }

      if (change.status === "added" && change.currentPath !== undefined) {
        artifactChanges.push(
          createArtifactChange({
            current: await artifactState(input.repositoryRoot, targetRevision, change.currentPath),
            kind: "added",
          }),
        );
      } else if (change.status === "deleted" && change.previousPath !== undefined) {
        artifactChanges.push(
          createArtifactChange({
            kind: "deleted",
            previous: await artifactState(
              input.repositoryRoot,
              input.baseRevision,
              change.previousPath,
            ),
          }),
        );
      } else if (
        change.status === "modified" &&
        change.currentPath !== undefined &&
        change.previousPath !== undefined
      ) {
        artifactChanges.push(
          createArtifactChange({
            current: await artifactState(input.repositoryRoot, targetRevision, change.currentPath),
            kind: "modified",
            previous: await artifactState(
              input.repositoryRoot,
              input.baseRevision,
              change.previousPath,
            ),
          }),
        );
      } else if (
        change.status === "renamed" &&
        change.currentPath !== undefined &&
        change.previousPath !== undefined
      ) {
        artifactChanges.push(
          createArtifactChange({
            current: await artifactState(input.repositoryRoot, targetRevision, change.currentPath),
            kind: "renamed",
            previous: await artifactState(
              input.repositoryRoot,
              input.baseRevision,
              change.previousPath,
            ),
          }),
        );
      }
    }

    const targetLabel = targetRevision ?? "WORKTREE";
    return {
      changeSet: createChangeSet({
        baseRevision: input.baseRevision,
        changes: artifactChanges,
        repositoryId: input.repositoryId,
        targetRevision: targetLabel,
      }),
      diagnostics,
    };
  }

  public async fingerprintWorkingTree(repositoryRoot: string): Promise<string> {
    const head = await runGitBuffer(repositoryRoot, ["rev-parse", "HEAD"]);
    const trackedDiff = await runGitBuffer(repositoryRoot, ["diff", "--binary", "HEAD", "--"]);
    const untrackedPaths = (
      await runGitBuffer(repositoryRoot, ["ls-files", "-z", "--others", "--exclude-standard"])
    )
      .toString("utf8")
      .split("\0")
      .filter((path) => path.length > 0)
      .sort();
    const untrackedState: Buffer[] = [];
    for (const path of untrackedPaths) {
      const absolutePath = join(repositoryRoot, path);
      try {
        const stat = await fileSystem.lstat(absolutePath);
        if (!stat.isFile()) {
          untrackedState.push(Buffer.from(`${path}\0not-file\0`));
          continue;
        }
        const file = await fileSystem.open(absolutePath, "r");
        const prefix = new Uint8Array(Math.min(stat.size, 8_192));
        try {
          await file.read(prefix, 0, prefix.length, 0);
        } finally {
          await file.close();
        }
        const policy = this.filePolicy.evaluate({
          contentPrefix: prefix,
          path,
          sizeBytes: stat.size,
        });
        if (!policy.supported) {
          untrackedState.push(Buffer.from(`${path}\0${policy.reason}\0${stat.size}\0`));
          continue;
        }
        untrackedState.push(
          Buffer.from(`${path}\0${hash(await fileSystem.readFile(absolutePath))}\0`),
        );
      } catch (error) {
        untrackedState.push(
          Buffer.from(`${path}\0${error instanceof Error ? error.name : "unreadable"}\0`),
        );
      }
    }
    return hash(Buffer.concat([head, trackedDiff, ...untrackedState]));
  }

  public async headRevision(repositoryRoot: string): Promise<string> {
    return (await runGitBuffer(repositoryRoot, ["rev-parse", "HEAD"])).toString("utf8").trim();
  }

  public async isWorkingTreeClean(repositoryRoot: string): Promise<boolean> {
    const status = await runGitBuffer(repositoryRoot, ["status", "--porcelain=v1", "-z"]);
    return status.length === 0;
  }
}

export const gitNameStatusParserForTesting = { parse: parseNameStatus };
