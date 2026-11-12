import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { About } from 'api-schemas';

import { Public } from '../auth/decorators/public.decorator';
import { AboutService } from './about.service';
import { AboutDto } from './dto/about.dto';

/**
 * The public "this is a Cloudgate" answer.
 *
 * The Cloudgate CLI asks it, with no credential, before it sends a key to an
 * address: anything that does not answer it is refused and never sees the key.
 * So it has to be `@Public()`, and it has to tell a Cloudgate apart from any
 * other site, which a `{ status: 'ok' }` like `GET /settings/health`'s cannot.
 *
 * **The version is public on purpose.** `GET /settings/version` and the
 * runtime inventory stay behind a session because a fleet's exact versions are
 * a targeting aid; this one number is the price of the CLI refusing an
 * Instance it cannot work with before it fails halfway through a command
 * (the spec's Version compatibility). It answers nothing else off the
 * install, and touches neither the database nor Docker, so it answers even
 * while those are down.
 *
 * Its own controller and service, under `/settings` beside `health`, so that
 * it needs none of `SettingsController`'s collaborators.
 */
@Controller('settings')
export class AboutController {
  constructor(private readonly aboutService: AboutService) {}

  @Public()
  @Get('about')
  @ApiOkResponse({
    type: AboutDto,
    description:
      'Public. Names this as a Cloudgate, its server version, the ' +
      "API's own origin for WebSockets (null when CLOUDGATE_API_URL is unset), " +
      'and whether this is the Hosted instance or a Self-hosted one.',
  })
  about(): Required<About> {
    return this.aboutService.about();
  }
}
