# IntelliRepo Runtime Integration Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-21-intellirepo-runtime-integration-design.md`

**Goal:** Connect the existing repository, parsing, PostgreSQL graph, documentation, impact, embeddings, Q&A, Ollama, API, worker, and web modules into one durable initial/incremental indexing flow with BullMQ as the default dispatcher and an explicit in-process local-demo adapter.

**Implementation rule:** PostgreSQL remains the only canonical and traversal database. No checkpoint may make deterministic indexing, graph exploration, impact, documentation analysis, or structural Q&A depend on Ollama. Neo4j is not composed into the runtime.

## Checkpoint 1: Runtime contracts and configuration

### Task 1.1: Extend scan and capability contracts

**Files**

- Modify `packages/contracts/src/jobs/scan-job.ts`
- Modify `packages/contracts/src/product-api.ts`
- Modify `packages/contracts/src/jobs/scan-job.test.ts`
- Modify `packages/contracts/src/product-api.test.ts`

**Work**

- Add `bullmq` and `inline` dispatch modes, durable dispatch state, stage counts, diagnostics, lease/heartbeat summary, and recoverability metadata to scan responses.
- Keep the existing scan stage names, including `PROJECTING_GRAPH`, for stored-job compatibility; make `PROJECTING_GRAPH` a required compatibility no-op rather than an optional external projection.
- Mark `EMBEDDING` as degradable and allow `ANALYZING` to be recoverably incomplete after canonical activation.
- Replace the Neo4j capability field with PostgreSQL canonical/traversal, semantic projection, worker dispatch, and Ollama capability fields.
- Make `selectedTraversalAdapter` PostgreSQL-only and expose canonical revision, semantic revision, and analysis revision lag separately.
- Add typed responses for graph neighborhoods, impact reports, documentation review retrieval, and scan diagnostics so the web application does not consume `unknown`.

**Verification**

- Contract tests reject invalid dispatch modes, negative counts, invalid lease timestamps, and impossible stage/state combinations.
- Existing clients can still deserialize previously stored jobs that do not contain the new optional metadata.
- No public product response advertises Neo4j.

### Task 1.2: Validate runtime configuration

**Files**

- Modify `packages/contracts/src/config.ts`
- Modify `packages/contracts/src/config.test.ts`
- Modify `packages/contracts/src/doctor.ts`
- Modify `.env.example`

**Work**

- Add `INDEXING_MODE`, worker concurrency, lease duration, heartbeat interval, dispatch polling interval, retry/backoff, and repository scan file-count limits.
- Require Redis settings only when `INDEXING_MODE=bullmq`; never switch to inline mode because Redis health fails.
- Retain Ollama URL/model/timeout/concurrency configuration and default Ollama to enabled for the documented local profile while keeping explicit disable support.
- Remove Neo4j configuration from active application contracts and doctor output. Legacy environment variables may be ignored during this pass but must not influence runtime composition.
- Validate that heartbeat is shorter than the lease duration and that retry/backoff values remain bounded.

**Verification**

- Configuration tests cover default BullMQ mode, explicit inline mode without Redis, invalid timing relationships, and Ollama disabled mode.
- Doctor output reports PostgreSQL/pgvector, Redis/worker mode, and Ollama independently.

## Checkpoint 2: Durable runtime state

### Task 2.1: Add the runtime integration migration

**Files**

- Create `packages/catalog/migrations/003_runtime_integration.ts`
- Modify `packages/catalog/src/database-types.ts`
- Modify `packages/catalog/src/database.ts`
- Modify `packages/catalog/src/catalog.integration.test.ts`

**Work**

- Extend `scan_jobs` with dispatch mode/state, structured counts and diagnostics, lease owner, lease expiry, heartbeat, and recoverable-stage metadata.
- Create `question_tasks` for queued/running/succeeded/failed question state and revision-scoped result/error payloads.
- Extend `documentation_reviews` with target path, original checksum, request/manifest metadata, and sufficient proposed content to reload and apply a preview after restart.
- Add revision-scoped analysis completion state or projection rows for documentation/impact aggregates so the API can distinguish canonical facts from incomplete analysis.
- Add indexes for pending outbox events, recoverable jobs, active leases, question polling, and repository/revision review lookup.
- Keep migrations additive and safe for databases created by migrations 001 and 002.

**Verification**

- PostgreSQL integration tests migrate both an empty database and a database already at migration 002.
- Foreign keys prevent cross-repository revision references.
- New JSON defaults deserialize through strict TypeScript types.

### Task 2.2: Deepen scan and outbox catalogs

**Files**

- Modify `packages/catalog/src/scan-job-catalog.ts`
- Modify `packages/catalog/src/outbox.ts`
- Create `packages/catalog/src/runtime-state.integration.test.ts`
- Modify `packages/catalog/src/index.ts`

**Work**

- Add atomic job creation, compare-and-set stage transitions, dispatch acknowledgement, lease acquire/renew/release, stale-lease recovery, and retry preparation.
- Add outbox listing/claiming, published marking, failure release, and bounded reconciliation operations.
- Ensure a deterministic job identifier plus database guards make submission and delivery idempotent.
- Persist stage timing, counts, diagnostics, degraded reasons, and attempt state in the same transition transaction.
- Prevent a second worker or inline callback from executing a job with a live lease.

**Verification**

- Concurrent lease tests yield one owner.
- Duplicate `scan.requested` insertion and duplicate publication are harmless.
- A stale lease can be recovered; a live lease cannot.
- Retry resumes the earliest incomplete recoverable stage without deleting completed-stage evidence.

## Checkpoint 3: Safe repository snapshots

### Task 3.1: Add snapshot and source loading primitives

**Files**

- Modify `packages/repository/src/local-repository-adapter.ts`
- Modify `packages/repository/src/git-change-detector.ts`
- Create `packages/repository/src/repository-snapshot.ts`
- Create `packages/repository/src/repository-snapshot.test.ts`
- Modify `packages/repository/src/index.ts`

**Work**

- Add safe UTF-8 artifact reads through the existing allowed-root, realpath, symlink, binary, and maximum-size policy boundary.
- Capture HEAD commit, working-tree fingerprint, inventory fingerprint, and repository state needed to validate a scan before activation.
- Build an initial change set by treating every supported artifact as added.
- Build incremental change sets from the previous active revision, including added, modified, deleted, and renamed files.
- Convert unreadable, ignored, binary, oversized, and unsupported artifacts into stable diagnostics instead of aborting the inventory.
- Recheck the snapshot fingerprint immediately before canonical activation and return a typed stale-snapshot conflict when content changed.

**Verification**

- Tests cover path traversal, symlink escape, deleted files, worktree changes, rename detection, binary/oversized files, and snapshot mutation during a scan.
- Source content is loaded only for supported files selected by the initial or incremental change set.

## Checkpoint 4: Shared indexing runtime and dispatch

### Task 4.1: Create the indexing package and deep runtime interface

**Files**

- Create `packages/indexing/package.json`
- Create `packages/indexing/tsconfig.json`
- Create `packages/indexing/src/index.ts`
- Create `packages/indexing/src/runtime/indexing-runtime.ts`
- Create `packages/indexing/src/runtime/postgres-indexing-runtime.ts`
- Create `packages/indexing/src/runtime/postgres-indexing-runtime.test.ts`
- Modify `tsconfig.json`
- Modify `pnpm-lock.yaml`

**Work**

- Define the approved `submit`, `status`, and `retry` interface without exposing queue or database implementation details.
- Implement submission as one transaction that validates repository input, creates or reuses the revision/job, and writes `scan.requested` to the outbox.
- Return existing active or recoverable work for the same repository and target fingerprint.
- Keep API-visible status derived from PostgreSQL rather than BullMQ memory.
- Make retry eligibility depend on stored recoverability and current repository fingerprint.

**Verification**

- Runtime tests cover initial submission, duplicate submission, incremental parent selection, status lookup, invalid repository, nonrecoverable failure, and retry.
- No controller needs to construct `ScanJobSnapshot` directly.

### Task 4.2: Add BullMQ and inline dispatch adapters

**Files**

- Create `packages/indexing/src/dispatch/scan-dispatcher.ts`
- Create `packages/indexing/src/dispatch/bullmq-scan-dispatcher.ts`
- Create `packages/indexing/src/dispatch/inline-scan-dispatcher.ts`
- Create `packages/indexing/src/dispatch/dispatcher.contract.test.ts`
- Create `packages/indexing/src/dispatch/outbox-dispatcher.ts`
- Create `packages/indexing/src/dispatch/outbox-dispatcher.integration.test.ts`

**Work**

- Publish one BullMQ job named `scan` with `jobId` equal to the durable scan job identifier.
- Configure bounded attempts/backoff while treating PostgreSQL as the source of stage retry truth.
- Make inline dispatch schedule the same executor asynchronously and return after durable acceptance.
- Add a bounded outbox pump that claims pending scan events, delegates dispatch, and marks successful publication.
- On dispatch failure, release the outbox claim and preserve a visible pending/failed dispatch state for later reconciliation.
- Close BullMQ/Redis resources through application lifecycle hooks.

**Verification**

- Both adapters pass one shared contract suite.
- Replaying an outbox event creates one BullMQ job.
- Inline dispatch does not execute before the submission transaction commits.
- Redis failure leaves a pending event that succeeds after recovery.

## Checkpoint 5: Executable deterministic scan pipeline

### Task 5.1: Build the stage executor and resumable context

**Files**

- Create `packages/indexing/src/executor/scan-executor.ts`
- Create `packages/indexing/src/executor/scan-context.ts`
- Create `packages/indexing/src/executor/scan-stage.ts`
- Create `packages/indexing/src/executor/scan-executor.test.ts`

**Work**

- Acquire and heartbeat the durable lease before running stages.
- Advance the existing stage sequence through compare-and-set catalog transitions.
- Persist stage inputs that are required for retry rather than depending on process memory.
- Skip completed idempotent stages on resume and stop immediately when the lease is lost.
- Record structured counts, diagnostics, elapsed time, degradation, and recoverability for every stage.
- Implement `PROJECTING_GRAPH` as a measured no-op with no Neo4j dependency or network call.

**Verification**

- Unit tests prove stage order, no-op graph projection, lease loss, recoverable resume, nonrecoverable failure, and duplicate execution protection.
- BullMQ and inline execution produce equivalent snapshots for the same fixture.

### Task 5.2: Connect discovery, parsing, resolution, and activation

**Files**

- Create `packages/indexing/src/executor/stages/discover-stage.ts`
- Create `packages/indexing/src/executor/stages/extract-stage.ts`
- Create `packages/indexing/src/executor/stages/commit-facts-stage.ts`
- Create `packages/indexing/src/executor/stages/deterministic-stages.integration.test.ts`
- Modify `packages/catalog/src/artifact-catalog.ts` as required for bulk snapshot upsert
- Modify `packages/catalog/src/fact-activation.ts` only where required for resumable activation metadata

**Work**

- Use `LocalRepositoryAdapter`, `GitChangeDetector`, `ExtractionPipeline`, `createDefaultAdapterRegistry`, and `IncrementalExtractionCoordinator` rather than duplicating parser logic.
- Initial scans parse every supported artifact; incremental scans parse only added, modified, and renamed destinations.
- Preserve full-project detection context while selecting only changed artifacts for extraction.
- Stage artifact-owned facts, recalculate affected relationships, and remove facts for deleted or renamed-away artifacts.
- Activate the revision atomically and supersede the previous active revision only after the snapshot fingerprint recheck succeeds.
- Preserve unaffected artifact facts and source references.

**Verification**

- PostgreSQL integration fixtures cover one Java/Spring, Kotlin/Ktor or Vert.x, and TypeScript/NestJS or Express repository.
- A change affecting fewer than twenty files parses only those destinations, preserves unaffected facts, and updates endpoints/tests/config relationships.
- A commit failure leaves the previous revision active; a changed worktree fails before activation.

## Checkpoint 6: Semantic projection and revision-scoped analysis

### Task 6.1: Build selective semantic sources

**Files**

- Create `packages/indexing/src/semantic/semantic-source-builder.ts`
- Create `packages/indexing/src/semantic/semantic-source-builder.test.ts`
- Create `packages/indexing/src/executor/stages/embedding-stage.ts`
- Modify `packages/embeddings/src/projector.ts`
- Modify `packages/embeddings/src/postgres-semantic-store.ts`
- Extend `packages/embeddings/src/postgres-semantic-store.integration.test.ts`

**Work**

- Select public classes/functions/methods, endpoints, configuration consumers, useful module/file context, Markdown sections, and changed high-impact regions.
- Exclude generated/vendor content, lockfiles, import-only fragments, trivial entities, and duplicate boilerplate.
- Include repository, revision, artifact, source range, content hash, chunk kind, and model identity in each chunk.
- Reuse unchanged embeddings only when both content checksum and embedding model match.
- Preserve the previous semantic projection and record lag/degradation if embedding fails.

**Verification**

- Tests prove selection and exclusion rules, redaction, checksum/model reuse, revision filtering, removal of stale chunks, and Ollama-unavailable degradation.
- No test expects one embedding per graph entity.

### Task 6.2: Run documentation and impact analysis after activation

**Files**

- Create `packages/indexing/src/executor/stages/analysis-stage.ts`
- Create `packages/indexing/src/analysis/revision-analysis.ts`
- Create `packages/indexing/src/analysis/revision-analysis.integration.test.ts`
- Modify `packages/impact/src/report-store.ts` as needed for idempotent replacement
- Modify `packages/documentation/src/documentation-catalog.ts` as needed for idempotent replacement

**Work**

- Read the active target revision and its parent through existing PostgreSQL fact snapshot/traversal adapters.
- Compute affected subgraph, endpoint/module/test/documentation impact, explainable risk, stale claims, gaps, and health aggregates.
- Store every result with the target revision and replace only the same revision's previous analysis.
- Mark analysis current only when deterministic analysis finishes.
- Treat analysis failure after activation as recoverable without reverting canonical facts.

**Verification**

- Rerunning analysis creates no duplicate reports or findings.
- API, config, removed-entity, missing-doc, test-impact, and risk fixtures are revision-scoped.
- Analysis lag is distinguishable from semantic lag and canonical fact state.

## Checkpoint 7: Ollama runtime and deterministic fallback

### Task 7.1: Add capability-aware Ollama composition

**Files**

- Create `packages/ai/src/ollama/ollama-runtime.ts`
- Create `packages/ai/src/ollama/ollama-runtime.test.ts`
- Modify `packages/ai/src/ollama/ollama-client.ts`
- Modify `packages/ai/src/index.ts`
- Modify `packages/ai/src/ollama.smoke.test.ts`

**Work**

- Add bounded health/model checks and return `available`, `degraded`, or `unavailable` with a safe last-failure summary.
- Construct the existing Ollama embedder and structured generator only when their configured models are healthy.
- Add bounded timeout and simple cooldown/circuit behavior so repeated failures do not block deterministic endpoints.
- Keep the real-model smoke test opt-in through environment configuration.

**Verification**

- Fake-server tests cover healthy models, missing models, timeout, malformed response, failure cooldown, and recovery.
- The opt-in smoke test performs one embedding and one citation-valid grounded generation on the local machine.

### Task 7.2: Wire semantic retrieval and generator fallback into Q&A

**Files**

- Modify `packages/qa/src/evidence-pack.ts`
- Modify `packages/qa/src/question-answerer.ts`
- Modify `packages/qa/src/qa.test.ts`

**Work**

- Combine bounded PostgreSQL structural evidence with optional revision-scoped semantic retrieval.
- If semantic retrieval or generation fails, return deterministic structural evidence with explicit degraded reasons.
- Preserve source references, confidence labels, retrieval modes, and inference validation in the stored answer.
- Never present semantic-only or low-confidence evidence as a confirmed relationship.

**Verification**

- Tests cover structural-only, hybrid, semantic failure, generation failure, citation rejection, and no-evidence answers.

## Checkpoint 8: Worker and API composition

### Task 8.1: Turn the worker into the BullMQ consumer

**Files**

- Modify `apps/worker/package.json`
- Modify `apps/worker/tsconfig.json`
- Modify `apps/worker/src/worker.module.ts`
- Modify `apps/worker/src/main.ts`
- Replace `apps/worker/src/queues/bullmq-scan-queue.ts` with `apps/worker/src/queues/scan-worker.ts`
- Replace or remove obsolete tests under `apps/worker/src/queues/`
- Modify `apps/worker/src/scan-orchestrator.ts` and `apps/worker/src/scan-state-machine.ts` only to remove duplicated lifecycle ownership
- Create `apps/worker/src/worker.integration.test.ts`

**Work**

- Compose PostgreSQL, repository adapters, parser registry, fact activation, semantic projection, revision analysis, Ollama runtime, and shared `ScanExecutor`.
- Consume one BullMQ job per scan and delegate all stage transitions to the shared executor.
- Configure concurrency independently from parser concurrency.
- Report PostgreSQL, Redis consumer, lease heartbeat, and Ollama health without reporting Neo4j.
- Close the queue worker, Redis connection, database, and health server cleanly.

**Verification**

- Worker integration tests process a submitted job, persist all stages, and recover an interrupted attempt.
- No stage-per-job `FlowProducer` remains in the active path.

### Task 8.2: Delegate API scan operations to the runtime

**Files**

- Modify `apps/api/package.json`
- Modify `apps/api/tsconfig.json`
- Create `apps/api/src/product/product-runtime.provider.ts`
- Create `apps/api/src/product/outbox-reconciler.ts`
- Modify `apps/api/src/product/product.module.ts`
- Modify `apps/api/src/product/product-facade.ts`
- Modify `apps/api/src/product/product.controllers.test.ts`

**Work**

- Compose `IndexingRuntime` with BullMQ or inline dispatch from validated configuration.
- Replace manual revision/job construction and retry mutation in `PostgresProductFacade` with runtime delegation.
- Start a bounded outbox reconciliation loop after module initialization and stop it during shutdown.
- In inline mode, construct the same executor and report the mode clearly; never instantiate Redis.
- Return typed graph, impact, documentation, question, diagnostics, and capability responses.
- Remove active Neo4j projection reads from overview and diagnostics.

**Verification**

- Controller/API tests cover submission, polling, retry conflicts, pending dispatch, inline mode, live capability state, and API restart.
- BullMQ mode does not run scan work inside the API process.

## Checkpoint 9: Durable Q&A and documentation review workflows

### Task 9.1: Persist question tasks before execution

**Files**

- Create `packages/qa/src/question-task-catalog.ts`
- Create `packages/qa/src/question-task-catalog.integration.test.ts`
- Modify `packages/qa/src/index.ts`
- Modify `apps/api/src/product/product-facade.ts`

**Work**

- Insert a queued task before scheduling answer work, transition it to running, and store the complete answer or safe error payload.
- Load polling responses from PostgreSQL rather than the facade's in-memory map.
- Construct structural traversal, semantic retrieval, and optional Ollama generation once in the API composition root.
- On API startup, mark abandoned running tasks recoverable or failed with a restart explanation; do not lose completed tasks.

**Verification**

- A submitted task can be polled after recreating the facade/database resource.
- Parallel repository tasks cannot be read across repository IDs.
- Ollama outage returns a succeeded deterministic answer with degradation, not a failed task.

### Task 9.2: Reload and safely apply documentation reviews

**Files**

- Modify `packages/documentation/src/documentation-catalog.ts`
- Modify `packages/documentation/src/review-workflow.ts`
- Extend `packages/documentation/src/documentation-catalog.integration.test.ts`
- Modify `apps/api/src/product/product-facade.ts`

**Work**

- Persist and reload the complete preview, target path, original checksum, fact manifest, citations, and explanation.
- Remove the facade's in-memory preview map.
- Validate repository ownership, active revision, path containment, original checksum, and pending review state before apply.
- Transition the review to applied atomically after the filesystem write; make duplicate apply return a conflict without rewriting.

**Verification**

- Preview then apply succeeds after an API restart.
- Changed target content, wrong repository, stale revision, path escape, and duplicate apply all fail safely.

## Checkpoint 10: Live dashboard and explicit demo routes

### Task 10.1: Remove fixture fallback from live data loading

**Files**

- Modify `apps/web/lib/product-api.ts`
- Create `apps/web/lib/live-dashboard-data.ts`
- Create `apps/web/components/product-error-state.tsx`
- Modify `apps/web/app/repositories/[repositoryId]/layout.tsx`
- Modify `apps/web/components/repository-shell.tsx`
- Extend `apps/web/lib/dashboard-model.test.ts`

**Work**

- Return typed live data or an explicit API error; remove the `portfolio` fallback mode from live routes.
- Increase or parameterize request timeouts for scan polling while keeping bounded server requests.
- Render registration/indexing-required, API-unavailable, no-active-revision, degraded, and analysis-incomplete states distinctly.
- Display PostgreSQL, pgvector, worker/inline, Ollama, semantic lag, and analysis lag; display no Neo4j row.

**Verification**

- A live API error never imports or renders sample repository facts.
- Capability and lag models cover BullMQ, inline, Ollama unavailable, semantic stale, and analysis incomplete states.

### Task 10.2: Wire every repository screen to live endpoints

**Files**

- Modify `apps/web/app/repositories/[repositoryId]/overview/page.tsx`
- Modify `apps/web/app/repositories/[repositoryId]/explorer/page.tsx`
- Modify `apps/web/app/repositories/[repositoryId]/impact/page.tsx`
- Modify `apps/web/app/repositories/[repositoryId]/documentation-health/page.tsx`
- Modify `apps/web/app/repositories/[repositoryId]/documentation/page.tsx`
- Modify `apps/web/app/repositories/[repositoryId]/ask/page.tsx`
- Modify `apps/web/components/ask-console.tsx`
- Create client components for scan, graph, documentation review/apply, and question polling under `apps/web/components/`

**Work**

- Add scan submission/progress/retry controls to the overview.
- Drive entity search and bounded neighborhood expansion through PostgreSQL API endpoints and show truncation metadata.
- Load revision-scoped impact, documentation findings, health, preview/apply state, and source references.
- Submit durable questions and poll until success/failure while showing retrieval mode and degraded reasons.
- Preserve the existing visual language while replacing every hard-coded metric, revision, entity, finding, diff, and capability value.

**Verification**

- Component/page tests cover loading, empty, success, error, bounded graph, stale review, scan retry, and question polling states.
- `rg` confirms live route files do not import `lib/demo-data`.

### Task 10.3: Preserve the portfolio fixture as an explicit demo

**Files**

- Create routes under `apps/web/app/demo/repositories/sample-auth-service/`
- Move or adapt fixture-only rendering from `apps/web/lib/demo-data.ts`
- Modify `apps/web/app/page.tsx`
- Add redirect behavior for the legacy sample fixture URL if required

**Work**

- Keep a polished fixture-backed walkthrough under `/demo/*` with an unmistakable demo banner.
- Distinguish fixture demo data from an inline scan of a real sample repository.
- Link the landing page to both repository registration/live operation and the fixture walkthrough.

**Verification**

- Demo routes work with the API stopped.
- Live repository routes never resolve IDs through fixtures.

## Checkpoint 11: End-to-end demo and operational verification

### Task 11.1: Add normal and inline acceptance suites

**Files**

- Create `apps/api/src/runtime.e2e.test.ts`
- Create `apps/web/app/runtime-dashboard.e2e.test.tsx` or the repository's selected browser E2E equivalent
- Create or extend a medium multi-language sample under `examples/`
- Modify `vitest.integration.config.ts`
- Modify `docker-compose.yml`

**Work**

- Run PostgreSQL, Redis, API, worker, and web in normal BullMQ mode and complete a real initial scan.
- Verify live overview, PostgreSQL traversal, discovered APIs, documentation health, impact, and grounded Q&A.
- Apply a prepared change affecting fewer than twenty Java, Kotlin, and TypeScript files and verify incremental parsing and atomic revision activation.
- Repeat the scan path in explicit inline mode without Redis.
- Run normal mode once with Ollama unavailable and verify deterministic success plus visible degradation.

**Verification**

- Both modes produce equivalent canonical facts and analyses for the same revision.
- Initial and incremental expected counts are asserted without timing-dependent sleeps.
- Restart checks prove scan status, question tasks, and documentation reviews are durable.

### Task 11.2: Document the working local demo

**Files**

- Modify `README.md`
- Modify `.env.example`
- Create or update local demo scripts through repository package scripts
- Add sample expected output under `docs/demo/` if useful

**Work**

- Document prerequisites, PostgreSQL/pgvector and Redis startup, Ollama model pulls, BullMQ default mode, explicit inline mode, repository registration, scan trigger, dashboard URLs, degraded behavior, and cleanup.
- Include a short interview-ready explanation of why canonical indexed facts outperform repeated whole-repository prompting for incremental impact, stale-doc checks, repeatable traversal, citations, and offline deterministic operation.
- Document current medium-repository limits and unsupported patterns honestly.

**Verification**

- Follow the README from a clean local database and reach the live dashboard without manual SQL.
- Confirm the documented Ollama-off path works.

## Checkpoint 12: Final repository gates

### Task 12.1: Run focused gates after every checkpoint

**Commands**

- `pnpm --filter @intellirepo/contracts test`
- `pnpm --filter @intellirepo/catalog test`
- `pnpm --filter @intellirepo/repository test`
- `pnpm --filter @intellirepo/indexing test`
- `pnpm --filter @intellirepo/worker test`
- `pnpm --filter @intellirepo/api test`
- `pnpm --filter @intellirepo/web test`
- `pnpm typecheck`
- `git diff --check`

### Task 12.2: Run the complete release gate

**Commands**

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:integration`
- `pnpm test:e2e`
- `pnpm build`
- `git diff --check`

**Completion**

- Fix all regressions inside the runtime-integration scope.
- Verify no live runtime composition imports Neo4j and no live dashboard route imports fixture data.
- Run the opt-in real Ollama smoke test when the configured local models are present; record a skipped result rather than failing the deterministic gate when they are absent.
- Commit each checkpoint with the configured `gaurav-madkaikar` identity.
- Push only when explicitly requested and only after the worktree is clean and the full applicable gate passes.
