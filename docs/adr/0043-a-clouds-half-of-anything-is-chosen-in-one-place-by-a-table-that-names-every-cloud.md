# A cloud's half of anything is chosen in one place, by a table that names every cloud

Status: accepted. Found in the code review of slices 6 and 7, findings S6, S7b and S9.

When Google Cloud joined AWS, each place that behaves differently per cloud learned Google by asking `cloud === 'gcp'` and treating every other answer as AWS. By then there were 62 such comparisons in 27 backend files, across plans, applies, deletes, drift, Domains, deploys, Stop and Start, the Runtime log and the Cloud account's own connect, check, edit, new key and delete. A third cloud, or a change to one cloud's flow, meant finding every one of them, and the one missed fell through to the other cloud's half without a word.

**Decided: the cloud seam is `backend/src/cloud-accounts/cloud-provider.ts`, and it is the only place outside the clouds' own folders that tells clouds apart.** It has two parts.

1. **Each behaviour's halves are chosen by a table keyed by `cloud`.** `onCloud(row, { aws, gcp })` calls the half for a Cloud account's cloud and hands it the row already narrowed to that cloud's account (`AwsCloudAccount`, `GcpCloudAccount`), so no half re-checks the cloud or casts the row. `byCloud(cloud, { aws, gcp })` does the same for a bare `cloud`, for facts such as a cloud's name, its OpenTofu provider or an idle network's cost. Both tables are typed over `cloud_kind`, so a cloud added to the enum is a type error at **every** site until that site says what it does there. Each table holds what its cloud does or is — a half, a value, a description, a set of facts such as `CLOUD_DOMAINS` — never only whether it is the one: a table of `true` and `false` would let a new cloud say "not Google" and so fall through to AWS's half again. A cloud that is not known (a shape written before Google Cloud accounts existed, or a Cloud account that is gone) is read by one named rule, `cloudOrLegacy`, as AWS, the only cloud there was; nothing else defaults to a cloud.
2. **A Cloud account's own lifecycle is a `CloudProvider` per cloud, registered by `cloud`.** Connect (setup and create), Check now, edit, the Deploy target's region check, the setup template, the view and what a Delete leaves behind live in `AwsProvider` (`cloud-accounts/aws/`) and `GoogleProvider` (`cloud-accounts/gcp/`). `CloudAccountsService` keeps what is the same on every cloud: the row, its Organization, the delete guards and the last check. What only one cloud has stays on that cloud's adapter and is not on the interface: the deploy role's session on AWS, and the run session and the key change on Google. `CloudAccountsService.deployRoleSession` and `googleRunSession` stay as pass-throughs to them for their many callers.

Each area's halves stay in that area, as named methods or services (for example `makeOnRds` and `makeOnCloudSql` in the postgres runs, `AwsPlanReads` and `GooglePlanReads` behind `CloudPlanReadsService`), and the table at the top of the area picks one.

**Why not one `CloudProvider` holding every area's behaviour.** That was the first shape the triage named. Plans, applies, deletes, Domains and the Runtime log each depend on their own module's services. One adapter per cloud holding all of them would make `cloud-accounts` import nearly every other module, which already imports `cloud-accounts`, and each adapter would grow to thousands of lines mixing unrelated areas. A change to Google's postgres apply would then mean editing a Google file far from the postgres code. The table keeps a cloud's half of an area next to the area, and still makes the choice of half in one checked place.

**Why not leave the comparisons and lint the else-branch.** A rule can say "no `=== 'gcp'` with an `else`", but it cannot tell a two-way branch that is really "Google, else AWS" from one that is really "Google, else anything". A table that must name every cloud can.

**What holds it.** `backend/test/coding-standards/cloud-comparisons.spec.ts` counts every `===`, `!==`, `==`, `!=` and `case` with a cloud's name, read from `cloud_kind`, in `backend/src` outside the seam file, `cloud-accounts/aws/**` and `cloud-accounts/gcp/**`. It also counts a bare default to a cloud (`?? 'aws'`), a table keyed by the clouds whose values are all `true` or `false`, and a comparison with a string one of the file's cloud tables answers (`instance === 'cloud-sql'`), which stands in for a cloud's name. Any of them fails it. The change moved the 62 one area per commit behind a baseline by file that could only shrink, and its last commit emptied the baseline and removed it.

**Consequences.**

- Adding a cloud starts with the enum. The type errors that follow are the list of everything the new cloud must say.
- `awsAccountOf` stays, for a use with an AWS half only. It refuses a Google row, by name, rather than read it as an AWS one with no key.
- The low-level client ports (`AwsCloudPort`, `GoogleCloudPort`) are unchanged. They are what the e2e specs fake, and the adapters above sit on them.

**What reopens this ADR:**

- an area whose halves on two clouds turn out to be the same code with different values, which would want one implementation with a per-cloud table of values instead of two halves;
- a cloud that is not a Cloud account (a Server-side runtime, for example), which the seam does not cover.
