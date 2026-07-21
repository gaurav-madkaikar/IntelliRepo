import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  GraphController,
  QuestionsController,
  RepositoriesController,
} from "./product.controllers.js";
import type { ProductFacade } from "./product-facade.js";

function fakeFacade(overrides: Partial<ProductFacade>): ProductFacade {
  return overrides as ProductFacade;
}

describe("product controllers", () => {
  it("passes the route repository to graph traversal instead of accepting it from the body", async () => {
    const graph = vi.fn().mockResolvedValue({ nodes: [] });
    const controller = new GraphController(fakeFacade({ graph }));

    await controller.neighborhood("repo-a", {
      maxDepth: 2,
      repositoryId: "repo-b",
      startEntityKeys: ["endpoint:POST:/api/login"],
    });

    expect(graph).toHaveBeenCalledWith(
      "repo-a",
      expect.objectContaining({ maxDepth: 2, startEntityKeys: ["endpoint:POST:/api/login"] }),
    );
    expect(graph.mock.calls[0]?.[1]).not.toHaveProperty("repositoryId");
  });

  it("keeps question polling repository scoped", async () => {
    const question = vi.fn().mockResolvedValue({ id: "question-1", state: "running" });
    const controller = new QuestionsController(fakeFacade({ question }));

    await controller.status("repo-a", "question-1");

    expect(question).toHaveBeenCalledWith("repo-a", "question-1");
  });

  it("returns actionable contract errors for invalid repository registration", () => {
    const controller = new RepositoriesController(fakeFacade({}));
    expect(() => controller.register({ rootPath: " " })).toThrow(BadRequestException);
  });
});
