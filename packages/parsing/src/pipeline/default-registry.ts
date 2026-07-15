import { ConfigurationExtractor } from "../configuration/configuration-extractor.js";
import { JavaExtractor } from "../languages/java/java-extractor.js";
import { KotlinExtractor } from "../languages/kotlin/kotlin-extractor.js";
import { TypeScriptExtractor } from "../languages/typescript/typescript-extractor.js";
import { GradleExtractor } from "../manifests/jvm/gradle-extractor.js";
import { MavenExtractor } from "../manifests/jvm/maven-extractor.js";
import { NodeManifestExtractor } from "../manifests/node/node-manifest-extractor.js";
import { AdapterRegistry } from "./adapter-registry.js";

export function createDefaultAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry()
    .registerExtractor(new JavaExtractor())
    .registerExtractor(new KotlinExtractor())
    .registerExtractor(new TypeScriptExtractor())
    .registerArtifactExtractor(new MavenExtractor())
    .registerArtifactExtractor(new GradleExtractor())
    .registerArtifactExtractor(new NodeManifestExtractor())
    .registerArtifactExtractor(new ConfigurationExtractor());
}
