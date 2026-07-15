import type { SourceLanguage } from "@intellirepo/domain";

import type { FrameworkAdapter } from "../interfaces/framework-adapter.js";
import type { ArtifactExtractor } from "../interfaces/artifact-extractor.js";
import type { LanguageExtractor } from "../interfaces/language-extractor.js";
import type { ProjectDetection } from "../interfaces/extraction.js";

export class AdapterRegistry {
  private readonly extractors = new Map<SourceLanguage, LanguageExtractor>();
  private readonly artifactExtractors: ArtifactExtractor[] = [];
  private readonly adapters: FrameworkAdapter[] = [];

  public registerExtractor(extractor: LanguageExtractor): this {
    if (this.extractors.has(extractor.language)) {
      throw new Error(`A ${extractor.language} extractor is already registered`);
    }
    this.extractors.set(extractor.language, extractor);
    return this;
  }

  public registerFrameworkAdapter(adapter: FrameworkAdapter): this {
    if (this.adapters.some(({ id }) => id === adapter.id)) {
      throw new Error(`Framework adapter ${adapter.id} is already registered`);
    }
    this.adapters.push(adapter);
    return this;
  }

  public registerArtifactExtractor(extractor: ArtifactExtractor): this {
    if (this.artifactExtractors.some(({ id }) => id === extractor.id)) {
      throw new Error(`Artifact extractor ${extractor.id} is already registered`);
    }
    this.artifactExtractors.push(extractor);
    return this;
  }

  public artifactExtractorFor(
    artifact: Parameters<ArtifactExtractor["supports"]>[0],
  ): ArtifactExtractor | undefined {
    const matches = this.artifactExtractors.filter((extractor) => extractor.supports(artifact));
    if (matches.length > 1) {
      throw new Error(`Multiple artifact extractors support ${artifact.path}`);
    }
    return matches[0];
  }

  public extractorFor(language: SourceLanguage): LanguageExtractor | undefined {
    return this.extractors.get(language);
  }

  public frameworkAdaptersFor(detection: ProjectDetection): readonly FrameworkAdapter[] {
    return this.adapters.filter((adapter) => adapter.supports(detection));
  }
}
