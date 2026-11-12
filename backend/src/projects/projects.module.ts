import { BucketsModule } from '../buckets/buckets.module';
import { Module } from '@nestjs/common';
import { ProjectConfigModule } from '../project-config';
import { TraefikModule } from '../traefik/traefik.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

/**
 * Feature-module template (copy for later domain phases):
 * - `project.schema.ts` — drizzle table + relations, re-exported from db/schema.ts
 * - `dto/` — zod schemas wrapped with createZodDto (validated by the global pipe)
 * - `.service.ts` — CRUD against DRIZZLE, org-scoped via PermissionCtx
 * - `.controller.ts` — thin routing + @RequirePermission for role checks
 */
@Module({
  // Delete tears every Application in the Project down, which includes removing
  // the dynamic config file the traefik module owns. No module for the
  // Services themselves: the teardown goes through the pure helpers in
  // `common/service-cascade.ts` rather than through ApplicationsService,
  // ComposeService and six database services, every one of which imports this
  // module back.
  // A new Project starts with an empty Project config.
  imports: [TraefikModule, ProjectConfigModule, BucketsModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
