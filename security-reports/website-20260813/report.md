# Security Review: Duck website and dashboard

## Scope

Internet-facing website, Discord OAuth, guild authorization, settings, model entitlements, billing webhook, and direct bot integration points.

- Scan mode: scoped_path
- Target kind: git_worktree
- Target ID: duck-website-current-worktree
- Revision: 14bc3db
- Snapshot digest: codex-security-snapshot/v1:sha256:c68f580f9f1e7fd750027b09d86e5b777bb1deca1284a88f463c406e5a0ddb7e
- Inventory strategy: scoped_path
- Included paths: src/web.js, src/dashboard-config.js, public/, src/core.js, .env.template, config.example.json, README.md, test/web.test.js, test/dashboard-config.test.js
- Excluded paths: none
- Runtime or test status: not recorded

### Scan Summary

| Field | Value |
| --- | --- |
| Reportable findings | 0 |
| Severity mix | none |
| Confidence mix | none |
| Coverage | complete |
| Validation mode | not recorded |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

A public internet attacker or authenticated Discord user may attempt to steal sessions, cross guild boundaries, alter settings or entitlements, inject browser content, replay webhooks, or exhaust the service.

### Assets

- Discord OAuth and refresh tokens
- dashboard sessions
- per-guild settings
- Plus entitlements
- AI and TTS API credentials
- website availability

### Trust Boundaries

- browser to Duck HTTP server
- Duck to Discord OAuth API
- billing adapter to signed webhook
- dashboard to guild settings persistence
- bot runtime to AI and TTS providers

### Attacker Capabilities

- send unauthenticated HTTP requests
- authenticate as a Discord user
- control Discord guild names and normal dashboard input
- replay an observed webhook delivery without learning its signing secret

### Security Objectives

- keep tokens and secrets server-side
- authorize every mutation against current Discord permissions
- isolate guild settings
- prevent user-controlled Plus grants
- reject stale or replayed billing state
- bound attacker-controlled resource use

### Assumptions

- TLS terminates correctly for duck.wispbyte.org
- Discord and configured provider endpoints are trusted
- billing adapters keep the webhook secret confidential

## Findings

### No findings

No reportable findings survived the canonical discovery, validation, and reportability gates.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Discord OAuth and session lifecycle | authentication | No issue found | State is stateless and HMAC-authenticated, cookies are HttpOnly SameSite and Secure in production, tokens remain server-side, and sessions expire. |
| Guild membership, permissions, and settings isolation | authorization | No issue found | Mutations refresh Discord guild permissions; Manage Server controls normal configuration while Administrator-only policy fields receive a separate check. Duck presence is required. |
| Dashboard DOM rendering and browser security headers | cross-site-scripting | No issue found | Discord strings are rendered through textContent, CSP is restrictive, external images are limited to Discord CDN, and state changes require a session-bound CSRF token. |
| Plus checkout and billing webhook | business-logic | No issue found | The browser cannot write subscription fields. HMAC signatures, fresh timestamps, persisted event ordering, and validated HTTPS checkout URLs protect entitlement state. |
| HTTP request and in-memory resource limits | denial-of-service | No issue found | Request bodies, sessions, request rates, sockets, and security-sensitive maps are bounded. Static assets are precompressed and cached. |
| Per-guild AI and TTS model integration | data-handling | No issue found | Plus is rechecked at runtime, Tencent is text-only, provider routing is server-controlled, and TTS responses are deadline and size bounded. |
