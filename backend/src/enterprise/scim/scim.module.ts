import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { scimWireFormat, SCIM_PROTOCOL_ROUTE } from './scim-wire';
import { ScimController } from './scim.controller';
import { ScimService } from './scim.service';

/** Enterprise SCIM 2.0 provisioning: an IdP manages members of an organization. */
@Module({
  controllers: [ScimController],
  providers: [ScimService],
  exports: [ScimService],
})
export class ScimModule implements NestModule {
  // The IdP-facing routes are better-auth's, mounted by `AuthController`, but
  // their wire format is SCIM's — see `scimWireFormat`. Registered here
  // rather than in `main.ts` so `createTestApp` gets it by importing AppModule.
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(scimWireFormat)
      .forRoutes({ path: SCIM_PROTOCOL_ROUTE, method: RequestMethod.ALL });
  }
}
