import { describe, expect, it } from "vitest";

import { createDefaultAdapterRegistry } from "../../pipeline/default-registry.js";
import { ExtractionPipeline } from "../../pipeline/extraction-pipeline.js";

describe("ExpressFrameworkAdapter", () => {
  it("extracts mounted routes and ordered middleware", async () => {
    const result = await new ExtractionPipeline(createDefaultAdapterRegistry()).extract({
      artifacts: [
        {
          artifactKind: "build",
          content: JSON.stringify({ dependencies: { express: "latest" } }),
          path: "package.json",
        },
        {
          artifactKind: "code",
          content: `function authMiddleware() {}
function getUserById() {}
const app = express();
const router = Router();
app.use("/api", router);
router.get("/users/:id", authMiddleware, getUserById);`,
          language: "typescript",
          path: "src/routes.ts",
        },
      ],
      repositoryId: "express-fixture",
      revisionId: "express-revision",
    });
    const entities = result.artifacts.flatMap(({ entities }) => entities);
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "endpoint", name: "GET /api/users/{id}" }),
        expect.objectContaining({ kind: "middleware", name: "authMiddleware" }),
      ]),
    );
  });
});
