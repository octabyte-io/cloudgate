// The running version, read from backend/package.json; the version, reload
// and update endpoints report and compare against it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const packageInfo = require('../../package.json') as { version: string };

export const CLOUDGATE_VERSION = packageInfo.version;
