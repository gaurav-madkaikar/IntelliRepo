import { ConfigurationExtractor } from "../configuration/configuration-extractor.js";
import { ExpressFrameworkAdapter } from "../frameworks/express/express-adapter.js";
import { KtorFrameworkAdapter } from "../frameworks/ktor/ktor-adapter.js";
import { NestFrameworkAdapter } from "../frameworks/nest/nest-adapter.js";
import { SpringFrameworkAdapter } from "../frameworks/spring/spring-adapter.js";
import { VertxFrameworkAdapter } from "../frameworks/vertx/vertx-adapter.js";
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
    .registerFrameworkAdapter(new SpringFrameworkAdapter())
    .registerFrameworkAdapter(new NestFrameworkAdapter())
    .registerFrameworkAdapter(new KtorFrameworkAdapter())
    .registerFrameworkAdapter(new VertxFrameworkAdapter())
    .registerFrameworkAdapter(new ExpressFrameworkAdapter())
    .registerArtifactExtractor(new MavenExtractor())
    .registerArtifactExtractor(new GradleExtractor())
    .registerArtifactExtractor(new NodeManifestExtractor())
    .registerArtifactExtractor(new ConfigurationExtractor());
}
