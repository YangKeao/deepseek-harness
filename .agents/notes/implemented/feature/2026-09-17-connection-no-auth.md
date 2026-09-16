# Agent Note: Connection authentication behind external access control

Status: implemented

English | [中文](2026-09-17-connection-no-auth.zh.md)

## Problem

The homelab deployment controls access outside Harness and requires browser entry without a second login or persisted browser-session secret. Maintaining this policy as a patch to bundled JavaScript leaves source declarations, tests, and documentation unable to describe the deployed behavior.

## Decision

Connection exposes `authentication: browser-token | none`, defaulting to `browser-token`. The existing process-token exchange and signed-cookie implementation remains the default. Explicit `none` omits the browser-authentication owner entirely: it generates no launch token, accesses no browser-session credential record, and issues no cookie. The plugin still requires the credentials service for composition compatibility; other credential owners are unaffected.

Both modes apply the existing Host, Origin, and Fetch-Metadata checks before index authorization and API dispatch. Trust rejection returns 403 before any token exchange or URL cleanup. These routing checks do not authenticate non-browser clients, so none mode requires externally enforced access control over the complete Host, including WebSocket upgrades. It adds neither forwarded-header interpretation nor a new bind policy.

In none mode, launch URLs retain the origin and root path only. A root GET with any `token` query parameter receives a 303 redirect to `/`, `Cache-Control: no-store`, and `Referrer-Policy: no-referrer`, without `Set-Cookie`; this removes obsolete launch credentials before serving the application. Other methods and index paths do not perform token cleanup. Existing cookies and signing records remain untouched, allowing browser-token mode to resume its existing credential policy.

This partially supersedes the unconditional authentication requirement in the [browser-token decision](../architecture/2026-08-24-browser-token-authentication.md), which remains active for the default mode. The [browser-trust decision](../architecture/2026-07-28-api-browser-trust-boundary.md) remains active because disabling authentication never disables its request checks.

## Verification

Connection source tests cover configuration defaults and rejection, credential initialization only in browser-token mode, clean launch URLs, none-mode index and API access, trust rejection before token handling in both modes, and the method/path limits on obsolete-token cleanup. Frontend tests boot credentials, Connection, webserver, and static serving through the real Loader, checking cookie-free none-mode responses and default-mode token exchange, 401 responses, cookie reuse, and 403 precedence. Header-forgery cases use Node HTTP rather than Fetch so the requested Host reaches the server unchanged. Existing browser-auth tests retain signing, lifetime, authority, and restart coverage. These are HTTP-entry behaviors, not Session transcript changes; their expected responses stay in owner-local tests.

## Alternatives considered

**Keep patching bundled JavaScript.** This preserves deployed behavior but leaves the maintained TypeScript and source tests inconsistent with the shipped package. Implementing the same policy in its existing owner removes that discrepancy without adding a second authorization path.

**Disable trust checks together with authentication.** External identity checks do not replace protection against cross-site requests or DNS rebinding. Both index serving and API dispatch retain the same request-trust policy.

**Initialize browser authentication but skip cookie verification.** This still creates browser credentials and launch tokens that none mode does not use. Omitting the owner avoids those side effects rather than hiding them.

## Consequences

The default remains authenticated. In none mode, anyone who can reach the Host and send accepted routing headers can use its full tool-capable API unless external access control stops them. `trustedHosts` is not an access-control substitute. Operators own that deployment risk; Harness does not validate the external authentication system. Cookie revocation and browser-token lifetime policy remain unchanged when authentication is enabled.
