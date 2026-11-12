# Reuse better-auth mounted inside NestJS

Cloudgate's auth (sessions, orgs, 2FA, API keys) is built on better-auth. We mount a better-auth instance inside the NestJS app and wrap `validateRequest` in NestJS guards, rather than rewriting auth with Passport or a custom solution. Session/token semantics and the auth schema are better-auth's own, and auth logic stays out of hand-rolled code.
