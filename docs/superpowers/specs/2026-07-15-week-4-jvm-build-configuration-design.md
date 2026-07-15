# IntelliRepo Week 4 JVM, Build, and Configuration Design

## 1. Objective

Week 4 extends IntelliRepo's normalized parsing kernel with repository-local Java and Kotlin intelligence plus deterministic build and configuration facts. It establishes the language and metadata foundation needed by the Spring Boot, Ktor, and Vert.x framework adapters scheduled for Week 5.

The implementation remains local-first, runs inside the TypeScript monorepo, and does not require a JDK, Kotlin compiler, Maven, or Gradle to be installed. It targets incomplete and medium-sized repositories, so extraction must recover from missing dependencies and invalid files without failing the scan.

## 2. Scope

Week 4 includes:

- Java package, import, type, member, annotation, inheritance, call, and test extraction.
- Kotlin package, import, type, object, constructor, function, extension, annotation, inheritance, call, DSL-structure, and test extraction.
- Repository-local Java and Kotlin symbol resolution.
- Maven, Gradle Groovy, Gradle Kotlin DSL, `package.json`, and `tsconfig.json` metadata extraction.
- Spring-style properties and YAML, `.env.example` variable names, and source-level configuration consumers.
- Deterministic diagnostics, source provenance, confidence, redaction, and mixed-language identity behavior.

Week 4 excludes:

- Spring Boot endpoint and dependency-injection interpretation.
- Ktor route and plugin interpretation.
- Vert.x router, verticle, and handler-chain interpretation.
- Full compiler-grade overload resolution, external dependency resolution, and runtime-generated behavior.
- Executing build tools or evaluating arbitrary build scripts.

Framework-specific annotations and Kotlin DSL calls are preserved as source facts during Week 4, but only Week 5 adapters may promote them to framework entities such as endpoints or middleware.

## 3. Architecture

The selected approach is a shared Tree-sitter JVM kernel with thin Java and Kotlin language layers.

### 3.1 Shared JVM kernel

`packages/parsing/src/languages/jvm/` owns:

- WASM Tree-sitter initialization and grammar loading.
- Parse-tree traversal and source-range conversion.
- Shared fact and relationship construction.
- Syntax-error collection and diagnostic normalization.
- Repository-local symbol declarations and lookup indexes.
- Resolution utilities for packages, imports, nesting, inheritance, and callable names.

The shared kernel is internal to `@intellirepo/parsing`. Consumers continue to use the existing `LanguageExtractor` interface and normalized extraction result types.

### 3.2 Java extractor

`packages/parsing/src/languages/java/` maps Java grammar nodes into normalized facts for:

- Packages and imports, including wildcard and static imports.
- Classes, interfaces, records, and enums.
- Nested types, fields, constructors, methods, and annotations.
- Extends and implements clauses.
- Method and constructor calls.
- Unit and integration test declarations where supported by syntax and naming evidence.

### 3.3 Kotlin extractor

`packages/parsing/src/languages/kotlin/` maps Kotlin grammar nodes into normalized facts for:

- Packages, imports, and aliases.
- Classes, interfaces, objects, companion objects, and primary constructors.
- Member, top-level, local, and extension functions.
- Annotations and inheritance.
- Calls, receiver expressions, nested lambdas, and DSL nesting needed by future Ktor analysis.
- Unit and integration test declarations where supported by syntax and naming evidence.

### 3.4 Build and configuration extractors

`packages/parsing/src/manifests/jvm/`, `packages/parsing/src/manifests/node/`, and `packages/parsing/src/configuration/` own metadata parsing. These components produce the same artifact-scoped normalized results as language extractors and are invoked by the extraction pipeline for supported build and configuration artifacts.

Manifest and configuration parsing remains separate from language syntax mapping. This prevents Maven, Gradle, YAML, and environment-file concerns from leaking into the Java and Kotlin extractors.

## 4. Extraction and Resolution Flow

For each repository revision, the pipeline performs the following sequence:

1. Detect languages, build files, configuration files, and common Maven or Gradle source roots.
2. Parse each artifact independently with its language or metadata parser.
3. Emit artifact-owned entities, relationships, unresolved references, diagnostics, and exact source ranges.
4. Build a repository-local symbol index from packages, imports, qualified names, nesting, callable names, and signatures.
5. Resolve imports, inheritance, calls, and test relationships across Java and Kotlin artifacts.
6. Link source consumers to configuration definitions when a unique local match exists.
7. Validate every artifact result through the existing extraction validation boundary.

Resolution never fetches dependencies or executes project code. Java and Kotlin may coexist in one repository, and their stable identities include language plus qualified symbol identity so equivalent names cannot collide accidentally.

## 5. Resolution and Confidence Rules

Resolution uses deterministic evidence tiers:

- **Confirmed:** a unique fully qualified reference or explicit import resolves to one local declaration.
- **High inferred confidence:** a unique same-package, wildcard-import, receiver-type, or compatible callable-signature match exists.
- **Tentative:** multiple plausible local candidates remain after deterministic filtering.
- **Unresolved:** the target is external, missing, dynamic, or cannot be distinguished safely.

Only unique matches produce resolved relationships. Tentative and unresolved references remain diagnostics or unresolved-reference records and are never presented as confirmed calls or inheritance.

Cross-language Java/Kotlin relationships use the same rules. A Java declaration and Kotlin declaration with the same simple name remain distinct unless package, import, and signature evidence identifies one unique target.

## 6. Build Intelligence

### 6.1 Maven

Maven extraction covers:

- Group, artifact, version, module, and packaging metadata where statically declared.
- Compiler, Java, and Kotlin version hints.
- Dependencies, scopes, and relevant plugins.
- Deterministic commands for wrapper-preferred build, test, and supported run tasks.

Property references are resolved only when their values are statically available in the same model. Unresolved interpolation produces a diagnostic rather than a guessed value.

### 6.2 Gradle

Gradle Groovy and Kotlin DSL extraction covers common declarative patterns for:

- Plugins, modules, project name, repositories, dependencies, configurations, and toolchains.
- Java and Kotlin runtime or language hints.
- Wrapper-preferred build, test, and supported run commands.

The parser does not execute Gradle. Dynamic expressions, custom functions, and computed dependency coordinates are retained as unsupported-expression diagnostics.

### 6.3 Node and TypeScript metadata

Node metadata extraction covers:

- `package.json` name, package manager, scripts, dependencies, dev dependencies, and common test tooling.
- Deterministic script-backed start, build, and test commands.
- `tsconfig.json` project references, include/exclude hints, and source-layout metadata.

These facts complement the existing TypeScript source extractor and use the same provenance and validation rules.

## 7. Configuration Intelligence and Redaction

Configuration definitions are extracted from:

- `application.properties` and other supported property files.
- `application.yml` and `application.yaml` using flattened dotted keys.
- `.env.example` names without retaining assigned values.

Source consumers include supported direct property-access calls, annotation arguments, Kotlin configuration access, and existing TypeScript `process.env` uses. A unique definition-to-consumer match emits `READS_CONFIG`; absent or ambiguous definitions remain unresolved evidence.

Security rules are mandatory:

- `.env` contents are not indexed.
- `.env.example` values are never persisted.
- Values for secret-like keys are redacted before fact construction.
- Parsers never log or include rejected secret values in diagnostics.
- Unsupported YAML constructs and dynamic expressions produce diagnostics instead of flattened guesses.

## 8. Normalized Facts

Week 4 uses the existing domain model and emits:

- Language entities such as package, class, interface, object, method, function, and test.
- Metadata entities such as dependency, build script, configuration key, and environment variable.
- Relationships including `CONTAINS`, `DECLARES`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `CALLS`, `TESTS`, `DEPENDS_ON`, and `READS_CONFIG`.

Every emitted entity and relationship includes revision-tagged provenance and a valid source range. Artifact-scoped ownership permits incremental replacement without affecting facts owned by unchanged files.

## 9. Failure Handling

Parsing is artifact-isolated. One invalid Java, Kotlin, XML, YAML, JSON, or Gradle artifact cannot abort repository extraction.

- Recoverable Tree-sitter parses emit valid facts alongside syntax diagnostics.
- Unrecoverable artifacts emit diagnostics and no guessed relationships.
- Invalid XML, JSON, properties, or YAML produces an artifact-level diagnostic.
- Unsupported static-analysis patterns remain explicit diagnostics.
- Framework enrichment continues to receive valid results from unaffected artifacts.

The existing pipeline validation remains the final boundary for rejecting malformed source ranges, invalid revisions, or relationships that violate normalized contracts.

## 10. Verification Strategy

### 10.1 Java fixtures

Golden fixtures cover packages, nested types, records, enums, fields, constructors, overloads, static imports, annotations, inheritance, tests, invalid syntax, and unresolved external calls.

### 10.2 Kotlin fixtures

Golden fixtures cover companion objects, primary constructors, top-level functions, extension functions, nested lambdas, annotations, inheritance, ambiguous receivers, tests, and invalid syntax.

### 10.3 Mixed-language fixtures

Mixed Java/Kotlin fixtures prove:

- Stable identities do not collide.
- Explicit cross-language imports can resolve uniquely.
- Ambiguous simple names remain tentative or unresolved.

### 10.4 Build and configuration fixtures

Fixtures cover Maven, Gradle Groovy, Gradle Kotlin DSL, `package.json`, `tsconfig.json`, properties, YAML, and `.env.example`. Tests assert deterministic commands and dependencies, safe interpolation behavior, configuration-consumer links, value redaction, and unsupported-expression diagnostics.

### 10.5 Completion gates

Week 4 is complete when:

- Java, Kotlin, manifest, and configuration contract and golden tests pass.
- Existing TypeScript and pipeline tests remain green.
- Every emitted fact contains valid provenance and source ranges.
- Ambiguous relationships are never upgraded to confirmed.
- Secret and `.env.example` values are absent from stored facts and diagnostics.
- Formatting, lint, type-checking, unit tests, build, and available integration checks pass.

Implementation is organized into reviewable Java, Kotlin, and build/configuration checkpoints before publishing the completed Week 4 history.
