'use strict';

/**
 * The octokit family is ESM-only and publishes exports maps with only an
 * "import" condition, which jest's CJS resolver cannot match. Node 24's
 * require(esm) handles them at runtime; under jest we resolve just these
 * packages with the "import" condition and let ts-jest transform them
 * (see transformIgnorePatterns).
 */
const OCTOKIT_MODULES =
  /^(octokit$|@octokit\/|universal-user-agent$|universal-github-app-jwt$|before-after-hook$)/;

module.exports = (request, options) => {
  if (OCTOKIT_MODULES.test(request)) {
    return options.defaultResolver(request, {
      ...options,
      conditions: ['node', 'import', 'default'],
    });
  }
  return options.defaultResolver(request, options);
};
