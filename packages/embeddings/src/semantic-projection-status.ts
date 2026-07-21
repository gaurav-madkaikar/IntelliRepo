import { ProjectionStateCatalog } from "@intellirepo/catalog";

import type { SemanticProjectionStatusWriter } from "./projector.js";

export class CatalogSemanticProjectionStatusWriter implements SemanticProjectionStatusWriter {
  public constructor(private readonly states: ProjectionStateCatalog) {}

  public async record(
    input: Parameters<SemanticProjectionStatusWriter["record"]>[0],
  ): Promise<void> {
    const previous = await this.states.find(input.repositoryId, "semantic");
    const current = input.result.state === "current";
    await this.states.save({
      ...(input.result.statusReason === undefined
        ? {}
        : { error: { message: input.result.statusReason } }),
      projection: "semantic",
      repositoryId: input.repositoryId,
      ...(current
        ? { revisionId: input.requestedRevisionId }
        : previous?.revision_id === null || previous?.revision_id === undefined
          ? {}
          : { revisionId: previous.revision_id }),
      state:
        input.result.state === "current"
          ? "current"
          : input.result.state === "disabled"
            ? "disabled"
            : "failed",
    });
  }
}
