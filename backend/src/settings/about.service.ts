import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { About } from 'api-schemas';

import type { Env } from '../common/config/env.schema';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { CLOUDGATE_VERSION } from './version';

/**
 * The public "this is a Cloudgate" answer: the product, the server
 * version, the API's own origin and the instance mode, read off the
 * process alone, so it answers while the database and Docker are down.
 */
@Injectable()
export class AboutService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly instanceMode: InstanceMode,
  ) {}

  /** What `GET /settings/about` answers; public, so nothing else off the install. */
  about(): Required<About> {
    const apiUrl = this.config.get('CLOUDGATE_API_URL', { infer: true });
    return {
      product: 'cloudgate',
      version: CLOUDGATE_VERSION,
      apiUrl: apiUrl ? new URL(apiUrl).origin : null,
      mode: this.instanceMode.mode,
    };
  }
}
