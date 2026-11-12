import { quote } from 'shell-quote';

import { dockerLoginCommand } from '../registries/registry.utils';

/**
 * **The pull half of the build that copies a ready-made image**
 * (ADR-0047): on the Hosted instance a cloud Service whose source is an
 * image is not pulled on the shared platform host. A short build in its
 * cloud's build service (CodeBuild, Cloud Build) pulls it and pushes it to
 * the Service's own repository, as the Cloud account's build identity.
 * Pure: every value is the caller's. Each cloud's script adds its own push
 * (`codebuild-program.ts`, `google-build-program.ts`).
 *
 * **A private registry's password never travels as a value.** It is written
 * to the cloud's secret store for this one build (an SSM SecureString on
 * AWS, a Secret Manager secret on Google Cloud), the build is started
 * naming only where it is, the build service reads it as the build identity
 * into {@link REGISTRY_PASSWORD_VARIABLE}, and Cloudgate deletes it once
 * the build has ended, however it ended. It is not in the zip, not a
 * plain-text build variable, and not in the start call. The script logs in
 * against a throwaway `DOCKER_CONFIG`, from the variable through stdin, then
 * forgets both before the push.
 */

/** The variable the build service hands the registry password in. */
export const REGISTRY_PASSWORD_VARIABLE = 'CG_SOURCE_REGISTRY_PASSWORD';

/** The ready-made image and how to sign in to its registry. */
export interface ImageCopySource {
  readonly image: string;
  readonly registryUrl: string | null;
  readonly username: string | null;
  /** Whether a password is handed to the build in {@link REGISTRY_PASSWORD_VARIABLE}. */
  readonly signsIn: boolean;
  /** The platform it is pulled for (`linux/amd64` on Cloud Run), or the build's own. */
  readonly platform: string | null;
}

/** Whether a source's credentials make the copy sign in: a username and a password, as on the platform host. */
export function copySignsIn(source: {
  readonly username: string | null;
  readonly password: string | null;
}): boolean {
  return Boolean(source.username && source.password);
}

/** The script lines that pull the image, signed in when it needs to be. */
export function imageCopyLines(source: ImageCopySource): string[] {
  const { image, platform } = source;
  const pull = `docker pull ${platform ? `--platform ${quote([platform])} ` : ''}${quote([image])}`;
  const failed = quote([`❌ Failed to pull image ${image}`]);
  const signIn = source.signsIn
    ? [
        'DOCKER_CONFIG="$(mktemp -d)"',
        'export DOCKER_CONFIG',
        `if [ -z "\${${REGISTRY_PASSWORD_VARIABLE}:-}" ]; then`,
        `  echo ${quote(["❌ The registry password was not handed to this build by the cloud's secret store"])} >&2`,
        '  exit 1',
        'fi',
        `if ! ${dockerLoginCommand(source.registryUrl, source.username, REGISTRY_PASSWORD_VARIABLE)}; then`,
        `  echo ${quote(['❌ Registry login failed'])} >&2`,
        '  exit 1',
        'fi',
        `unset ${REGISTRY_PASSWORD_VARIABLE}`,
      ]
    : [];
  const signOut = source.signsIn
    ? ['rm -rf "$DOCKER_CONFIG"', 'unset DOCKER_CONFIG']
    : [];
  return [
    `echo ${quote([`📥 [Copy] Pulling image ${image}`])}`,
    ...signIn,
    `if ! ${pull}; then`,
    `  echo ${failed} >&2`,
    '  exit 1',
    'fi',
    ...signOut,
    `echo ${quote([`✅ Pulled image ${image}`])}`,
  ];
}
