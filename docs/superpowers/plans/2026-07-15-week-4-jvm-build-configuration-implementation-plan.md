# IntelliRepo Week 4 JVM, Build, and Configuration Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-15-week-4-jvm-build-configuration-design.md`

**Goal:** Add fault-tolerant Java and Kotlin extraction plus deterministic build and configuration intelligence to the existing normalized parsing pipeline without requiring JVM build tools.

## Checkpoint 1: Shared JVM kernel

### Task 1.1: Add JVM grammar runtime

**Files**

- Modify `pnpm-workspace.yaml`
- Modify `packages/parsing/package.json`
- Create `packages/parsing/src/languages/jvm/tree-sitter-runtime.ts`
- Create `packages/parsing/src/languages/jvm/syntax.ts`

**Work**

- Add the prebuilt Java and Kotlin WASM grammar package as an explicit parsing dependency.
- Centralize parser initialization, grammar loading, tree cleanup, source ranges, and syntax-error diagnostics.
- Cache immutable language instances while creating one parser per parse operation.

**Verification**

- Parse valid and invalid Java/Kotlin snippets without a local JDK.
- Return one-based source ranges and artifact-owned syntax diagnostics.

### Task 1.2: Add shared fact and symbol primitives

**Files**

- Create `packages/parsing/src/languages/jvm/fact-factory.ts`
- Create `packages/parsing/src/languages/jvm/symbol-index.ts`
- Create `packages/parsing/src/languages/jvm/extractor-support.ts`

**Work**

- Construct language-specific normalized facts with shared provenance behavior.
- Represent package/import/declaration/call candidates independently from grammar nodes.
- Resolve only unique repository-local candidates using qualified name, explicit import, package, receiver, and arity evidence.
- Keep ambiguous and external references unresolved.

**Verification**

- Stable keys differ across Java and Kotlin when names otherwise match.
- Unique matches resolve; ambiguous matches retain candidate keys and diagnostics.

## Checkpoint 2: Java extraction

### Task 2.1: Extract Java declarations and relationships

**Files**

- Create `packages/parsing/src/languages/java/java-extractor.ts`
- Create Java fixture files under `packages/parsing/src/languages/java/fixtures/`
- Create `packages/parsing/src/languages/java/java-extractor.test.ts`
- Modify `packages/parsing/src/index.ts`

**Work**

- Extract packages, imports, classes, interfaces, records, enums, constructors, fields, methods, annotations, extends/implements, method calls, constructor calls, and test methods.
- Preserve modifiers and normalized signatures where statically available.
- Resolve local imports, inheritance, and callable targets after all Java artifacts are parsed.
- Emit syntax recovery and unresolved-reference diagnostics without aborting healthy artifacts.

**Verification**

- Golden coverage includes nested types, static imports, overloads, annotations, tests, invalid syntax, and external calls.
- Every fact has valid source provenance.

## Checkpoint 3: Kotlin extraction

### Task 3.1: Extract Kotlin declarations and relationships

**Files**

- Create `packages/parsing/src/languages/kotlin/kotlin-extractor.ts`
- Create Kotlin fixture files under `packages/parsing/src/languages/kotlin/fixtures/`
- Create `packages/parsing/src/languages/kotlin/kotlin-extractor.test.ts`
- Modify `packages/parsing/src/index.ts`

**Work**

- Extract packages, imports and aliases, classes, interfaces, objects, companion objects, primary constructors, member/top-level/extension functions, annotations, inheritance, calls, tests, and nested DSL calls.
- Resolve unique repository-local Kotlin and Java declarations through the shared symbol index.
- Preserve ambiguous receiver calls as unresolved evidence.

**Verification**

- Golden coverage includes companion objects, extension and top-level functions, lambdas, annotations, tests, invalid syntax, and ambiguous receivers.
- Mixed Java/Kotlin fixtures prove non-colliding identities and safe cross-language resolution.

## Checkpoint 4: Build intelligence

### Task 4.1: Add manifest extractor contract and pipeline integration

**Files**

- Create `packages/parsing/src/interfaces/artifact-extractor.ts`
- Modify `packages/parsing/src/pipeline/adapter-registry.ts`
- Modify `packages/parsing/src/pipeline/extraction-pipeline.ts`
- Modify `packages/parsing/src/pipeline/project-detector.ts`

**Work**

- Add artifact extractors for build/configuration files without overloading the one-extractor-per-language registry.
- Dispatch supported artifacts exactly once and isolate failures per artifact.
- Detect Maven, Gradle, Node, and JVM configuration paths and framework dependency hints.

**Verification**

- Language and artifact extractors coexist without duplicate ownership.
- Malformed metadata does not block source extraction.

### Task 4.2: Extract Maven and Gradle metadata

**Files**

- Create `packages/parsing/src/manifests/jvm/maven-extractor.ts`
- Create `packages/parsing/src/manifests/jvm/gradle-extractor.ts`
- Create `packages/parsing/src/manifests/jvm/jvm-manifest-extractors.test.ts`

**Work**

- Parse static Maven coordinates, modules, properties, dependencies, scopes, plugins, version hints, and wrapper-preferred commands.
- Parse common Gradle Groovy/Kotlin DSL plugins, dependencies, toolchains, modules, and commands without executing Gradle.
- Report dynamic or unsupported expressions instead of guessing.

**Verification**

- Fixtures yield deterministic dependency and build-script facts.
- Static property interpolation resolves; dynamic expressions produce diagnostics.

### Task 4.3: Extract Node and TypeScript metadata

**Files**

- Create `packages/parsing/src/manifests/node/node-manifest-extractor.ts`
- Create `packages/parsing/src/manifests/node/node-manifest-extractor.test.ts`

**Work**

- Extract package name, package manager, scripts, dependencies, dev dependencies, runtime hints, and deterministic start/build/test commands.
- Extract TypeScript project references and source-layout hints.

**Verification**

- Invalid JSON is isolated and reported.
- Script and dependency facts are stable across repeated extraction.

## Checkpoint 5: Configuration intelligence

### Task 5.1: Extract definitions safely

**Files**

- Create `packages/parsing/src/configuration/configuration-extractor.ts`
- Create `packages/parsing/src/configuration/configuration-extractor.test.ts`

**Work**

- Parse properties, supported YAML mappings, and `.env.example` names.
- Flatten YAML keys deterministically.
- Never persist `.env.example` values and redact secret-like property/YAML values.
- Diagnose unsupported YAML structures safely.

**Verification**

- Tests search serialized results and diagnostics to prove fixture secrets are absent.
- Every configuration fact has exact source provenance.

### Task 5.2: Link configuration consumers

**Files**

- Modify Java, Kotlin, and TypeScript extraction support as needed.
- Create `packages/parsing/src/configuration/configuration-linker.ts`
- Extend configuration integration tests.

**Work**

- Normalize source-level configuration uses into unresolved config references.
- Link unique definitions to consuming entities with `READS_CONFIG`.
- Leave absent or ambiguous definitions unresolved.

**Verification**

- Java, Kotlin, and TypeScript consumers link to unique definitions.
- Ambiguous keys never become confirmed relationships.

## Checkpoint 6: Final integration and validation

### Task 6.1: Register extractors and validate the complete pipeline

**Files**

- Modify `packages/parsing/src/index.ts`
- Extend pipeline and project detector tests.

**Work**

- Export public extractor entry points.
- Register and exercise language and artifact extractors through one pipeline fixture.
- Confirm affected artifact ownership and deterministic result ordering.

### Task 6.2: Run repository gates

**Commands**

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm test:integration`
- `git diff --check`

**Completion**

- Fix all regressions within Week 4 scope.
- Commit reviewable checkpoints with the configured `gaurav-madkaikar` identity.
- Push only after the worktree is clean and the complete validation set passes.
