# On the Hosted instance an SSO provider acts only for domains its Organization has proven

On the Hosted instance every account has a confirmed email, and the SSO plugin links an SSO sign-in onto an existing account whenever the identity provider says the address is verified (`sso({ trustEmailVerified: true })` with account linking on). Provider domains are claimed first come, first served and never proven. Together, these let one Enterprise Organization's identity provider sign in as any other customer's person: it registers `acme.com` and asserts `sam@acme.com`. So on the Hosted instance a provider's domains take effect only once its Organization proves each one with a DNS TXT record, and an SSO sign-in is refused unless its email is in one of that provider's proven domains. A person who arrives through SSO counts as confirmed, joins only that provider's Organization and never gets a new one. A Self-hosted instance is unchanged: one operator owns every Organization there, so nobody is a stranger to anybody.

## Considered Options

- **Turn off linking to existing accounts for SSO on the Hosted instance.** Rejected: a company moving its people to SSO would get a second, empty account for each of them. It also leaves a stranger's identity provider free to create accounts in a domain it does not own.
- **Octabyte checks domains by hand when it enables Enterprise.** Rejected: nothing in the product holds the check, so a domain added later, or a provider edited later, skips it.
- **Leave it as it is, because Enterprise is sold by contract.** Rejected: a contract does not stop an account takeover. It only gives Octabyte someone to blame after one.

## Consequences

- The SSO setup on the Hosted instance gains a "prove this domain" step (a TXT record checked by the backend) before the provider can be used.
- A domain stays first come, first served among providers, but an unproven claim routes nobody, so squatting a domain earns nothing.
