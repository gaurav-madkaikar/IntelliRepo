import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";

import type { CatalogDatabase } from "./database-types.js";
import { claimOutboxEvents } from "./outbox.js";
import { ScanJobCatalog } from "./scan-job-catalog.js";

const unreachableDatabase = {} as Kysely<CatalogDatabase>;

describe("runtime state catalog guards", () => {
  it("rejects invalid leases before accessing PostgreSQL", async () => {
    const catalog = new ScanJobCatalog(unreachableDatabase);

    await expect(catalog.acquireLease("scan-1", "", 30_000)).rejects.toThrow("owner");
    await expect(catalog.acquireLease("scan-1", "worker-1", 0)).rejects.toThrow("duration");
    await expect(catalog.renewLease("scan-1", "worker-1", -1)).rejects.toThrow("duration");
  });

  it("rejects unsafe outbox claim bounds before accessing PostgreSQL", async () => {
    await expect(claimOutboxEvents(unreachableDatabase, { owner: "" })).rejects.toThrow("owner");
    await expect(
      claimOutboxEvents(unreachableDatabase, { limit: 101, owner: "dispatcher-1" }),
    ).rejects.toThrow("limit");
    await expect(
      claimOutboxEvents(unreachableDatabase, {
        claimTimeoutMs: 0,
        owner: "dispatcher-1",
      }),
    ).rejects.toThrow("timeout");
  });
});
