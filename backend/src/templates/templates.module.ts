import { Module } from '@nestjs/common';
import { DomainsModule } from '../domains/domains.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { fetchClientProvider } from '../git-providers/fetch.provider';
import { ProjectConfigModule } from '../project-config/project-config.module';
import { ProjectsModule } from '../projects/projects.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { PendingSetupsController } from './pending-setups.controller';
import { PendingSetupAutoApply } from './setup/pending-setup-auto-apply.service';
import { PendingSetupSweep } from './setup/pending-setup-sweep.service';
import { PendingSetups } from './setup/pending-setups.service';
import { TemplateSetups } from './setup/template-setups.service';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

@Module({
  // Setup adds a template's entries through the config's whole-YAML save,
  // makes an own web's generated host where a value names it (#1375), and
  // makes a new Project from a template as the console makes one (#1376);
  // the 30-day sweep of Pending setups is a scheduled job (#1374), and so
  // is the get-started wizard's Apply (ADR-0073).
  imports: [
    ProjectConfigModule,
    DomainsModule,
    ProjectsModule,
    EnvironmentsModule,
    SchedulingModule,
  ],
  controllers: [TemplatesController, PendingSetupsController],
  providers: [
    TemplatesService,
    TemplateSetups,
    PendingSetups,
    PendingSetupSweep,
    PendingSetupAutoApply,
    fetchClientProvider,
  ],
  exports: [TemplatesService],
})
export class TemplatesModule {}
