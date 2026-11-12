import { Global, Module } from '@nestjs/common';
import { RemoteExecService } from './remote-exec.service';
import { SshForwardService } from './ssh-forward.service';

/**
 * Single funnel for all remote/local shell work, and for the one stream the
 * backend opens to a port on a remote Server (`SshForwardService`).
 * Global so any module can inject either without importing RemoteModule
 * explicitly.
 */
@Global()
@Module({
  providers: [RemoteExecService, SshForwardService],
  exports: [RemoteExecService, SshForwardService],
})
export class RemoteModule {}
