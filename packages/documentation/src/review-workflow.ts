import { promises as fileSystem } from "node:fs";
import path from "node:path";

import {
  defaultDocumentationPath,
  DocumentationGenerator,
  type DocumentationGenerationRequest,
  type DocumentationReviewPreview,
} from "./generation-plan.js";
import { contentChecksum } from "./review-diff.js";

export interface DocumentationWorkspace {
  read(relativePath: string): Promise<string | undefined>;
  write(relativePath: string, content: string): Promise<void>;
}

export class LocalDocumentationWorkspace implements DocumentationWorkspace {
  public constructor(private readonly rootPath: string) {}

  private resolve(relativePath: string): string {
    if (path.isAbsolute(relativePath))
      throw new Error("Documentation path must be repository-relative");
    const resolved = path.resolve(this.rootPath, relativePath);
    const relative = path.relative(path.resolve(this.rootPath), resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Documentation path escapes the repository root");
    }
    return resolved;
  }

  public async read(relativePath: string): Promise<string | undefined> {
    try {
      return await fileSystem.readFile(this.resolve(relativePath), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async write(relativePath: string, content: string): Promise<void> {
    const resolved = this.resolve(relativePath);
    await fileSystem.mkdir(path.dirname(resolved), { recursive: true });
    await fileSystem.writeFile(resolved, content, "utf8");
  }
}

export class DocumentationReviewWorkflow {
  public constructor(
    private readonly generator: DocumentationGenerator,
    private readonly workspace: DocumentationWorkspace,
  ) {}

  public async preview(
    request: Omit<DocumentationGenerationRequest, "originalMarkdown">,
  ): Promise<DocumentationReviewPreview> {
    const targetPath = request.targetPath ?? defaultDocumentationPath(request.kind, request.title);
    const original = (await this.workspace.read(targetPath)) ?? "";
    return this.generator.prepare({ ...request, originalMarkdown: original, targetPath });
  }

  public async apply(review: DocumentationReviewPreview, accepted: boolean): Promise<void> {
    if (!accepted) throw new Error("Documentation review must be explicitly accepted before apply");
    const current = (await this.workspace.read(review.path)) ?? "";
    if (contentChecksum(current) !== review.originalChecksum) {
      throw new Error("Documentation changed after preview; create a new review before apply");
    }
    await this.workspace.write(review.path, review.proposedMarkdown);
  }
}
