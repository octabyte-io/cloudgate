import { Module } from '@nestjs/common';
import { SshKeysController } from './ssh-keys.controller';
import { SshKeysService } from './ssh-keys.service';

@Module({
  controllers: [SshKeysController],
  providers: [SshKeysService],
  exports: [SshKeysService],
})
export class SshKeysModule {}
