import { Global, Module } from '@nestjs/common';
import { dockerClientProvider } from './docker-client.provider';
import { RemoteDockerFactory } from './remote-docker.factory';

/**
 * Docker access for the whole app: the local dockerode client plus the
 * factory that resolves per-server clients (local or over SSH). Global so
 * builds/databases/deploy modules can inject without importing explicitly.
 */
@Global()
@Module({
  providers: [dockerClientProvider, RemoteDockerFactory],
  exports: [dockerClientProvider, RemoteDockerFactory],
})
export class DockerModule {}
