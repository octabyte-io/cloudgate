import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from './decorators/public.decorator';
import { DeviceLoginService } from './device-login.service';
import {
  DeviceCodeDto,
  DeviceCodeRequestDto,
  DeviceTokenDto,
  DeviceTokenRequestDto,
} from './dto/device-login.dto';

/**
 * `cloudgate login`'s two routes, both `@Public()`: the CLI has no
 * credential yet, which is the point of logging in. Mounted at `/auth`, beside
 * `SignUpController`, rather than inside better-auth's `/api/auth` catch-all;
 * `DeviceLoginService` says why these are not better-auth's own.
 *
 * `@HttpCode(200)`: neither creates anything the caller can address, and the
 * poll's 200 is RFC 8628's.
 */
@Controller('auth/device')
export class DeviceLoginController {
  constructor(private readonly deviceLogin: DeviceLoginService) {}

  @Public()
  @Post('code')
  @HttpCode(200)
  @ApiOkResponse({
    type: DeviceCodeDto,
    description:
      'Starts a CLI login: a code for the person to approve at /device, and ' +
      'the device code the CLI polls with. Takes no fields; in particular no ' +
      'user, so a code is bound only to whoever approves it.',
  })
  start(@Body() body: DeviceCodeRequestDto) {
    // Declared only to be validated: the strict empty schema is what refuses
    // a user id (400) instead of ignoring it.
    void body;
    return this.deviceLogin.start();
  }

  @Public()
  @Post('token')
  @HttpCode(200)
  @ApiOkResponse({
    type: DeviceTokenDto,
    description:
      "The CLI's poll. Once the code is approved, a Personal key ending 90 " +
      'days after login, answered once; until then a 400 whose code is ' +
      'AUTHORIZATION_PENDING, SLOW_DOWN, EXPIRED_TOKEN, ACCESS_DENIED or ' +
      'INVALID_GRANT.',
  })
  poll(@Req() req: Request, @Body() body: DeviceTokenRequestDto) {
    return this.deviceLogin.poll(body, req.ip);
  }
}
