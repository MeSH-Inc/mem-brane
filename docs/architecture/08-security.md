# Security

Better Auth uses SQLite sessions and password authentication. Production serves UI and API from one HTTPS origin behind Caddy. Secure cookies and trusted origins belong to Better Auth; application mutations also validate Origin. Secrets and model keys are server-only. Never enable a development authentication bypass in production.

Centralized access helpers authorize read/edit/run on a brane and block/run/asset access. V1 uses owner checks inside this boundary only. Future brane membership and roles replace policy internals; userId is not permanently the only ownership model. Cross-brane reuse is permitted only after authorizing both records.

Uploads accept validated image signatures with configured byte limits, store opaque generated keys, and require authentication for reads. Disallow SVG/HTML active content. R2 credentials never reach the client. Signed links should be short-lived if used; v1 proxies reads through authorization.

Web ingestion validates HTTP(S), credentials, hostname and every redirect. Resolve and reject private/internal/reserved IPv4 and IPv6 addresses; pin the validated DNS address to prevent rebinding. Enforce redirect count, timeout and streamed byte limits. No headless browser. Plain extracted text is rendered as text, never injected HTML. Manual paste remains available on fetch failure.

Validate all API input. Bind configurable request rate-limit hooks at the API/auth boundary; per-user Run limits and upload/import bounds mitigate costs but do not replace edge abuse protection. Errors returned to clients avoid stack traces and secrets; server logs retain diagnostics. Back up SQL consistently and protect backup credentials. Sharing is deferred.
