import type { Command } from '../command.js';
import { deploy } from './deploy.js';
import { instanceList, instanceUse } from './instance.js';
import { link } from './link.js';
import { login } from './login.js';
import { logout } from './logout.js';
import { logs } from './logs.js';
import { status } from './status.js';
import { templateCheck } from './template-check.js';
import { templatePack } from './template-pack.js';
import { templateTry } from './template-try.js';
import { unlink } from './unlink.js';
import { vars } from './vars.js';
import { whoami } from './whoami.js';

/**
 * Every command, in the order the overview lists them within a group. A
 * command not here does not exist: there are no placeholders for the ones
 * later tickets add (the CLI spec lists them).
 */
export const COMMANDS: readonly Command[] = [
  login,
  logout,
  whoami,
  instanceList,
  instanceUse,
  link,
  unlink,
  deploy,
  status,
  logs,
  vars,
  templateCheck,
  templatePack,
  templateTry,
];
