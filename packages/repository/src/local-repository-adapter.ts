import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promises as fileSystem } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  FilePolicy,
  type FilePolicyRejectionReason,
  type SupportedFilePolicyDecision,
} from "./file-policy.js";

const execFile = promisify(execFileCallback);

export interface RegisteredLocalRepository {
  readonly defaultBranch?: string;
  readonly displayName: string;
  readonly id: string;
  readonly rootPath: string;
}

export interface RepositoryArtifactCandidate {
  readonly decision: SupportedFilePolicyDecision;
  readonly path: string;
  readonly sizeBytes: number;
}

export type RepositoryInventoryDiagnosticReason =
  | FilePolicyRejectionReason
  | "ignored"
  | "invalid-utf8"
  | "missing"
  | "not-file"
  | "symlink-escape"
  | "unreadable";

export interface RepositoryInventoryDiagnostic {
  readonly message: string;
  readonly path: string;
  readonly reason: RepositoryInventoryDiagnosticReason;
  readonly sizeBytes?: number;
}

export interface RepositoryInventory {
  readonly artifacts: readonly RepositoryArtifactCandidate[];
  readonly diagnostics: readonly RepositoryInventoryDiagnostic[];
}

export interface LoadedRepositoryArtifact extends RepositoryArtifactCandidate {
  readonly content: string;
  readonly contentHash: string;
}

export class RepositoryArtifactReadError extends Error {
  public constructor(
    public readonly artifactPath: string,
    public readonly reason: RepositoryInventoryDiagnosticReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RepositoryArtifactReadError";
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function contentHash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function runGit(rootPath: string, arguments_: readonly string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", rootPath, ...arguments_], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

function diagnostic(
  path: string,
  reason: RepositoryInventoryDiagnosticReason,
  message: string,
  sizeBytes?: number,
): RepositoryInventoryDiagnostic {
  return Object.freeze({
    message,
    path,
    reason,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  });
}

function readError(
  path: string,
  reason: RepositoryInventoryDiagnosticReason,
  message: string,
  cause?: unknown,
): RepositoryArtifactReadError {
  return new RepositoryArtifactReadError(
    path,
    reason,
    `${path}: ${message}`,
    cause === undefined ? undefined : { cause },
  );
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
      throw readError(artifactPath, "symlink-escape", "artifact path must be repository-relative");
    }

    const rootPath = await fileSystem.realpath(repositoryRoot);
    const candidate = resolve(rootPath, artifactPath);
    let realCandidate: string;
    try {
      realCandidate = await fileSystem.realpath(candidate);
    } catch (error) {
      throw readError(artifactPath, "missing", "artifact cannot be resolved", error);
    }

    if (!isWithinRoot(rootPath, realCandidate)) {
      throw readError(artifactPath, "symlink-escape", "artifact symlink escapes repository root");
    }

    return realCandidate;
  }

  private async inspectArtifact(
    repositoryRoot: string,
    artifactPath: string,
  ): Promise<RepositoryArtifactCandidate | RepositoryInventoryDiagnostic> {
    let resolvedPath: string;
    try {
      resolvedPath = await this.resolveArtifactPath(repositoryRoot, artifactPath);
    } catch (error) {
      if (error instanceof RepositoryArtifactReadError) {
        return diagnostic(artifactPath, error.reason, error.message);
      }
      return diagnostic(artifactPath, "unreadable", `${artifactPath}: artifact cannot be resolved`);
    }

    try {
      const stat = await fileSystem.stat(resolvedPath);
      if (!stat.isFile()) {
        return diagnostic(artifactPath, "not-file", "Repository entry is not a regular file");
      }
      const file = await fileSystem.open(resolvedPath, "r");
      const contentPrefix = new Uint8Array(Math.min(stat.size, 8_192));
      try {
        await file.read(contentPrefix, 0, contentPrefix.length, 0);
      } finally {
        await file.close();
      }
      const decision = this.filePolicy.evaluate({
        contentPrefix,
        path: artifactPath,
        sizeBytes: stat.size,
      });
      if (!decision.supported) {
        return diagnostic(
          artifactPath,
          decision.reason,
          `File policy rejected ${artifactPath}: ${decision.reason}`,
          stat.size,
        );
      }
      return Object.freeze({ decision, path: artifactPath, sizeBytes: stat.size });
    } catch (error) {
      return diagnostic(
        artifactPath,
        "unreadable",
        `${artifactPath}: ${error instanceof Error ? error.message : "artifact cannot be inspected"}`,
      );
    }
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
    const ignoredOutput = await runGit(rootPath, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
    ]);
    const ignoredDiagnostics = ignoredOutput
      .split("\0")
      .filter((path) => path.length > 0)
      .map((path) => diagnostic(path, "ignored", `Git ignore rules excluded ${path}`));
    const inspected = await Promise.all(paths.map((path) => this.inspectArtifact(rootPath, path)));
    const artifacts = inspected.filter(
      (candidate): candidate is RepositoryArtifactCandidate => "decision" in candidate,
    );
    const diagnostics = inspected.filter(
      (candidate): candidate is RepositoryInventoryDiagnostic => !("decision" in candidate),
    );

    return Object.freeze({
      artifacts: Object.freeze(artifacts),
      diagnostics: Object.freeze([...diagnostics, ...ignoredDiagnostics]),
    });
  }

  public async readArtifact(
    repositoryRoot: string,
    artifactPath: string,
  ): Promise<LoadedRepositoryArtifact> {
    const inspected = await this.inspectArtifact(repositoryRoot, artifactPath);
    if (!("decision" in inspected)) {
      throw readError(inspected.path, inspected.reason, inspected.message);
    }
    const resolvedPath = await this.resolveArtifactPath(repositoryRoot, artifactPath);
    let bytes: Buffer;
    try {
      bytes = await fileSystem.readFile(resolvedPath);
    } catch (error) {
      throw readError(artifactPath, "unreadable", "artifact cannot be read", error);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw readError(artifactPath, "invalid-utf8", "artifact is not valid UTF-8", error);
    }
    return Object.freeze({
      ...inspected,
      content,
      contentHash: contentHash(bytes),
    });
  }
}
