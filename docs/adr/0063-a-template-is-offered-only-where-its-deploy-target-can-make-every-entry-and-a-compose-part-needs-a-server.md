# A template is offered only where its Deploy target can make every entry, and a compose part needs a Server

Status: accepted. Extends [ADR-0035](0035-a-service-runs-on-a-server-or-in-a-cloud-account-fixed-when-it-is-created.md) to **Templates**. **The compose rule is superseded by [ADR-0070](0070-a-compose-stack-in-a-cloud-account-runs-on-its-own-stack-vm-made-by-opentofu-and-reached-through-the-clouds-tunnel.md)**: a Compose stack now runs in a Cloud account on its own Stack VM, so a template with a compose part can be set up in a Cloud Environment, its compose part reaching the template's own `postgres` over the Environment network. The rule that a template is offered only where its Deploy target can make every entry still stands, and a template Domain in a Cloud Environment starts with a host the user types, since a Stack VM has no generated host.

A cloud cannot run a Compose stack (ADR-0035; [ADR-0069](0069-a-compose-stack-is-described-by-the-file-it-names-never-by-a-copy-of-it.md), drafted as ADR-0061, refuses a `compose` entry in a Cloud Environment). Today's console sets a template up in a Cloud Environment anyway, by putting the whole stack on a Server the user names. With templates that mix own kinds and a compose part, doing the same would split one app: the `postgres` lands in the cloud on the Environment's private network, and the compose app lands on a Server that cannot reach it. The Apply would succeed and the app would not work.

## Decision

- **Offered by what the Deploy target can make, worked out by Cloudgate.** A template can be set up in an Environment only when every entry in its `cloudgate.yaml` is of a kind that Environment's Deploy target can make. A template's author never declares it: no "runs in a cloud" tag, no field in `template.yaml`. The check reads the same list of kinds per cloud that the plan reads, so a cloud that learns a kind starts offering the templates that use it without any template changing.
- **A compose part needs an Environment that deploys to a Server** (or the platform host where allowed). *Superseded by [ADR-0070](0070-a-compose-stack-in-a-cloud-account-runs-on-its-own-stack-vm-made-by-opentofu-and-reached-through-the-clouds-tunnel.md), as the status line says: in a Cloud Environment the compose part runs on its own Stack VM. This bullet, the paragraph above it and the example reason below record the rule as first decided.* This holds for a template that is only a compose part too. In a Cloud Environment the setup never asks "which Server?" and never puts any part of a template on a Server.
- **Shown, not hidden.** The console still lists the template. Where the user picks the Environment, one that cannot take the template is greyed out with its reason (for example "This template has a compose part, which runs only on a Server"). While browsing, a computed mark says where the template can run (for example "Runs on a Server or in a cloud").
- **The plan stays the backstop.** The plan's own refusal (ADR-0035: a kind the cloud cannot make refuses the plan, naming the entry, never moved to a Server) still applies, so YAML pasted into a repository-kept config gets the same answer at its next push.
- **Native settings follow the config's rules.** A template's `cloudgate.yaml` may carry `native` blocks under exactly the rules of [ADR-0044](0044-native-adds-settings-to-what-cloudgate-generates-never-resources.md): every block is checked on every plan, only the target's block is used, and the Cloudgate version a template needs (ADR-0062) hides one whose settings an install cannot check. Whether a template that relies on `native.docker` must also carry the matching cloud blocks is a catalogue review rule, not a setup rule.

## Considered options

- **Hide the template.** Rejected: people wonder where it went.
- **Let it be picked and refuse at Plan.** Rejected as the only answer: the user finds out at the last step. Kept as the backstop.
- **Put the compose part on a named Server and the rest in the cloud.** Rejected: the parts cannot reach each other (ADR-0035 leaves crossing between a Server and a cloud to the operator), so it "works" and the app is broken.
- **Keep today's behaviour for a compose-only template.** Rejected for one rule with fewer branches.

## Consequences

- Something that works today stops working: a compose-based template can no longer be set up in a Cloud Environment on a named Server. The user makes, or picks, an Environment that deploys to a Server.
- On the hosted instance an Organization with only Cloud accounts cannot set up any template with a compose part.
- Template authors are pushed toward own kinds (already the rule from charting), since that is what makes a template run everywhere.

## What reopens this ADR

A cloud that can run a Compose stack, or a supported way for a Server and a cloud in one Environment to reach each other.
