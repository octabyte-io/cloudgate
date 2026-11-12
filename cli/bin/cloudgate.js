#!/usr/bin/env node
// The `cloudgate` command npm links (ADR 0046).
//
// A launcher rather than the bundle itself, for two reasons:
//
// - **Room for a per-platform file.** ADR 0046 keeps open shipping a single
//   file per platform behind this same package name, through npm
//   `optionalDependencies`. When that lands, this is where the CLI looks for
//   the installed platform package and hands over to it, falling back to the
//   bundle below; nobody's install command changes.
// - **A clear refusal on an old Node.** `engines` makes npm refuse the install
//   only under `engine-strict`; by default it warns and installs. So the
//   version is checked here, in syntax any Node parses, before the bundle
//   (which needs Node 22) is loaded at all.
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  process.stderr.write(
    'Error: cloudgate needs Node 22 or newer; this is Node ' +
      process.versions.node +
      '.\n',
  );
  process.exit(1);
}

await import('../dist/cloudgate.mjs');
