import path from 'node:path';
import { getCreateFileCommand } from '../../docker/docker.utils';
import type {
  BuildCommandInput,
  BuildProgram,
  BuildStrategy,
} from '../build-strategy';
import { dockerfileStrategy } from './dockerfile.strategy';

const nginxSpaConfig = `
worker_processes 1;

events {
  worker_connections 1024;
}

http {
  include mime.types;
  default_type  application/octet-stream;

  access_log /dev/stdout;
  error_log /dev/stderr;

  server {
    listen 80;
    location / {
      root   /usr/share/nginx/html;
      index  index.html index.htm;
      try_files $uri $uri/ /index.html;
    }
  }
}
`;

/**
 * Materializes a Dockerfile that serves the publish directory with nginx,
 * then delegates to the dockerfile strategy to build it.
 *
 * It has no environment of its own — the three files it writes are fixed text —
 * so the environment it returns is whatever the dockerfile strategy it
 * delegates to declares. The `.dockerignore` it writes lists `.env`,
 * which is the reason the delegate's `createEnvFile` branch and this one have
 * never both mattered.
 */
export const staticStrategy: BuildStrategy = {
  buildType: 'static',

  getProgram(input: BuildCommandInput): BuildProgram {
    const { buildAppDirectory, publishDirectory, isStaticSpa } = input;

    let command = '';
    if (isStaticSpa) {
      command += getCreateFileCommand(
        buildAppDirectory,
        'nginx.conf',
        nginxSpaConfig,
      );
    }

    command += getCreateFileCommand(
      buildAppDirectory,
      '.dockerignore',
      ['.git', '.env', 'Dockerfile', '.dockerignore'].join('\n'),
    );

    command += getCreateFileCommand(
      buildAppDirectory,
      'Dockerfile',
      [
        'FROM nginx:alpine',
        'WORKDIR /usr/share/nginx/html/',
        ...(isStaticSpa ? ['COPY nginx.conf /etc/nginx/nginx.conf'] : []),
        `COPY ${publishDirectory || '.'} .`,
        'CMD ["nginx", "-g", "daemon off;"]',
      ].join('\n'),
    );

    // The Dockerfile just written above — never the application's own
    // `dockerfile` column, which says nothing about this generated nginx image.
    const delegate = dockerfileStrategy.getProgram({
      ...input,
      dockerfilePath: path.join(buildAppDirectory, 'Dockerfile'),
    });
    command += delegate.command;

    return { command, env: delegate.env };
  },
};
