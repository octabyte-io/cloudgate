# An upload of only the changed files is compared against the build host's files, never a saved list

Status: accepted.

`cloudgate deploy` uploaded every file of the folder each time, and the Instance deleted its copy and wrote every file again. Spec #10 sends a list of the folder's files with the SHA-256 of each instead: the Instance answers which of them its **Build host** lacks or holds different, and the CLI uploads only those. Something has to say what the Instance already holds, and the obvious answer, the list it was last sent, is wrong.

**The comparison hashes the files really in the code directory on the build host, each time.** After a build that directory is not what was uploaded: a Patch overwrites files in it, the dockerfile build can write a `.env` there, and a git source clones into the same directory. A saved list would answer "unchanged" for a file a Patch rewrote, and the next build would read the Patch's version where the folder holds another. Hashing what is there makes a file that differs, for whatever reason, simply asked for again; nothing has to know why it differs.

**Both halves run on the build host** (`buildHostServerId`, ADR-0018), as the full upload does: the comparison reads the tree the build will read, and the apply writes it there.

**The apply checks again before it swaps.** The tree can change between the comparison and the apply, so the apply builds the new tree beside the current one (a copy of it, less the files not in the list, plus the uploaded files) and swaps it in only when every file's fingerprint matches the list. Anything else, a mismatch or a failure part-way, leaves the previous tree in place and answers a 409 `UPLOAD_CONFLICT`; `cloudgate deploy` compares once more.

## Considered options

- **A list saved on the Instance from the last upload.** Rejected: it goes stale on the first Patch, `.env` or git checkout, and the cost of reading the tree instead is one `sha256sum` pass over files the build is about to read anyway.
- **Timestamps or sizes instead of a hash of the contents.** Rejected: a checkout, a copy or a clock on another machine changes a timestamp without changing a file, and a same-size edit changes neither size nor, on a coarse filesystem, the time.
- **Writing the changed files into the code directory in place.** Rejected: a connection that drops part-way leaves a half-updated mix that the next build would use; the tree built beside it and swapped in whole never is one.
