# A template may ship a JavaScript config file

Status: accepted. Amends [ADR-0072](0072-the-template-catalogue-is-one-zip-of-template-folders-and-a-zip-holding-anything-else-is-refused-whole.md).

ADR-0072 lists the endings a config file under a template's `files/` may have, and refuses scripts by name, `.js` among them. Some applications read their configuration as a JavaScript module, so a template for one of them cannot ship its config file. Formbricks is the first. The workaround, naming the file `config.js.txt` and binding it into the container as `config.js`, passes the check today, because `.txt` is on the list and the check reads only the name.

The workaround shows what the ending does and does not protect. Cloudgate never runs a config file: it writes the bytes into the Service's files directory, the zip's file modes are never read, and the file reaches the template's container only through a bind mount. What runs the file is the template's own container, which already runs whatever its image and its compose `command` say. A `.js` that the application reads adds nothing that the image cannot already do, so the ending is not a security boundary. What the list does buy is honesty: a reviewer of a `cg-templates` change sees what kind of file each one is. A `.txt` that is really code loses that.

## Decision

- **`.js` is a config ending.** A file under `files/` may end in `.js`, with every other rule of ADR-0072 unchanged: listed in `template.yaml`'s `files`, UTF-8 text with no NUL byte, at most 256 KB, inside the template's 1 MB, its path written plainly.
- **Only `.js`.** `.mjs`, `.cjs` and `.ts` are added only when a template needs one, by amending this ADR again. `.sh`, `.py` and other scripts stay refused: they are what a container is told to run, not what an application reads.
- **A config file is named for what it is.** A template ships its JavaScript config as `.js`, never under a `.txt` or other borrowed ending that is renamed by the mount. The check cannot see this, so it is a rule for reviewing `cg-templates`.

## Consequences

- `CONFIG_FILE_ENDINGS` in `backend/src/templates/check/catalogue-layout.ts` takes `.js`. The backend's catalogue check, `cloudgate template check` and `cloudgate template pack` share it, so all three take it in the same release.
- An install on an older Cloudgate refuses a whole catalogue zip that holds a `.js`, keeps its last good copy, and names the file in the console (ADR-0072). Installs read the latest `cg-templates` release, so a template with a `.js` is published only after a Cloudgate release that takes it. The catalogue format is not bumped: an older install would refuse a new format in the same way, and a newer one would refuse every catalogue built before it.
