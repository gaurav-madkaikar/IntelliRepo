import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fileSystem } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { FilePolicy, type FilePolicyDecision } from "./file-policy.js";

const execFile = promisify(execFileCallback);

export interface RegisteredLocalRepository {
  readonly defaultBranch?: string;
  readonly displayName: string;
  readonly id: string;
  readonly rootPath: string;
}

export interface RepositoryArtifactCandidate {
  readonly decision: FilePolicyDecision;
  readonly path: string;
  readonly sizeBytes: number;
}

export interface RepositoryInventory {
  readonly artifacts: readonly RepositoryArtifactCandidate[];
  readonly diagnostics: readonly RepositoryArtifactCandidate[];
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function runGit(rootPath: string, arguments_: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", rootPath, ...arguments_], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

export class LocalRepositoryAdapter {
  public constructor(
    private readonly allowedRoots: readonly string[],
    private readonly filePolicy: FilePolicy,
  ) {
    if (allowedRoots.length === 0) {
      throw new Error("At least one repository root must be allowed");
    }
  }

  private async resolveAllowedRoots(): Promise<readonly string[]> {
    return Promise.all(
      this.allowedRoots.map(async (root) => {
        try {
          return await fileSystem.realpath(resolve(root));
        } catch {
          return resolve(root);
        }
      }),
    );
  }

  public async register(candidatePath: string): Promise<RegisteredLocalRepository> {
    const requestedPath = resolve(candidatePath);
    const repositoryRootFromGit = await runGit(requestedPath, ["rev-parse", "--show-toplevel"]);
    const rootPath = await fileSystem.realpath(repositoryRootFromGit);
    const allowedRoots = await this.resolveAllowedRoots();

    if (!allowedRoots.some((allowedRoot) => isWithinRoot(allowedRoot, rootPath))) {
      throw new Error(`Repository path is outside configured roots: ${rootPath}`);
    }

    const defaultBranch = await runGit(rootPath, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]).catch(() => undefined);
    const id = createHash("sha256").update(rootPath).digest("hex").slice(0, 24);

    return {
      ...(defaultBranch === undefined || defaultBranch === "" ? {} : { defaultBranch }),
      displayName: basename(rootPath),
      id,
      rootPath,
    };
  }

  public async resolveArtifactPath(repositoryRoot: string, artifactPath: string): Promise<string> {
    if (isAbsolute(artifactPath)) {
      throw new Error("Artifact path must be repository-relative");
    }

    const rootPath = await fileSystem.realpath(repositoryRoot);
    const candidate = resolve(rootPath, artifactPath);
    const realCandidate = await fileSystem.realpath(candidate);

    if (!isWithinRoot(rootPath, realCandidate)) {
      throw new Error(`Artifact symlink escapes repository root: ${artifactPath}`);
    }

    return realCandidate;
  }

  public async inventory(repositoryRoot: string): Promise<RepositoryInventory> {
    const rootPath = await fileSystem.realpath(repositoryRoot);
    const output = await runGit(rootPath, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
    const paths = output.split("\0").filter((path) => path.length > 0);
    const candidates: RepositoryArtifactCandidate[] = [];

    for (const path of paths) {
      try {
        const resolvedPath = await this.resolveArtifactPath(rootPath, path);
        const stat = await fileSystem.stat(resolvedPath);
        const file = await fileSystem.open(resolvedPath, "r");
        const contentPrefix = new Uint8Array(Math.min(stat.size, 8_192));
        await file.read(contentPrefix, 0, contentPrefix.length, 0);
        await file.close();
        const decision = this.filePolicy.evaluate({
          contentPrefix,
          path,
          sizeBytes: stat.size,
        });
        candidates.push({ decision, path, sizeBytes: stat.size });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Repository file cannot be inspected";
        throw new Error(`${path}: ${message}`, { cause: error });
      }
    }

    return {
      artifacts: candidates.filter(({ decision }) => decision.supported),
      diagnostics: candidates.filter(({ decision }) => !decision.supported),
    };
  }
}
