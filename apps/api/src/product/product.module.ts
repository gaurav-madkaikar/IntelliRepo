import { Module } from "@nestjs/common";
import { loadApplicationConfig } from "@intellirepo/contracts";

import { PRODUCT_CONTROLLERS } from "./product.controllers.js";
import { DatabaseResource, PostgresProductFacade, PRODUCT_FACADE } from "./product-facade.js";

const APPLICATION_CONFIG = Symbol("APPLICATION_CONFIG");
const DATABASE_RESOURCE = Symbol("DATABASE_RESOURCE");

@Module({
  controllers: [...PRODUCT_CONTROLLERS],
  providers: [
    { provide: APPLICATION_CONFIG, useFactory: loadApplicationConfig },
    {
      inject: [APPLICATION_CONFIG],
      provide: DATABASE_RESOURCE,
      useFactory: (config: ReturnType<typeof loadApplicationConfig>) =>
        DatabaseResource.create(config.databaseUrl),
    },
    {
      inject: [DATABASE_RESOURCE, APPLICATION_CONFIG],
      provide: PRODUCT_FACADE,
      useFactory: (resource: DatabaseResource, config: ReturnType<typeof loadApplicationConfig>) =>
        new PostgresProductFacade(resource, config),
    },
  ],
})
export class ProductModule {}
