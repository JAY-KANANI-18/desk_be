# Axodesk Auth Blueprint

## Objective

Replace Supabase Auth with a self-hosted Axodesk authentication layer that:

- keeps `User` as the business identity record
- isolates authentication state in dedicated auth tables
- keeps existing `Organization`, `OrganizationMember`, `Workspace`, and `WorkspaceMember` authorization intact
- supports enterprise login/session/security controls
- scales horizontally with stateless API nodes and Redis acceleration

## Layering

### Identity layer

- `User` remains the canonical product identity
- `emailVerifiedAt` and `lastLoginAt` were added to support auth lifecycle without replacing the table

### Authentication layer

- `AuthCredential`
- `AuthSession`
- `RefreshToken`
- `OAuthAccount`
- `EmailVerificationToken`
- `PasswordResetToken`
- `MagicLinkToken`
- `OtpCode`
- `TrustedDevice`
- `LoginAttempt`
- `AuthAuditLog`
- `TwoFactorSecret`
- `BackupCode`

### Authorization layer

- `OrganizationMember.role`
- `WorkspaceMember.role`
- existing guards and permission matrices

## Token and Session Architecture

### Access token

- signed JWT
- 15 minute TTL by default
- contains `sub`, `sid`, `ver`, tenant scope hints, and auth provider
- validated locally on every API node

### Refresh token

- opaque random token
- hashed in Postgres
- stored in `HttpOnly` cookie
- rotated on every refresh
- family tracking through `tokenFamilyId` and `previousTokenId`
- reuse detection revokes the full family and current session

### Redis

- session context cache: `auth:session:{sessionId}`
- rate limiting keys: `auth:rate:*`
- OAuth state keys: `auth:google:state:*`
- supports stateless nodes and fast guard lookups

## Security Controls

- Argon2id hashing via `argon2`
- password policy enforcement in `AuthPasswordService`
- brute-force throttling in `AuthRateLimitService`
- email enumeration protection for reset/OTP/magic-link request flows
- audit logging in `AuthAuditLog`
- per-session revocation
- rotating refresh tokens with theft detection
- CSRF protection for cookie-backed refresh via double-submit token
- access token kept in memory on the frontend, refresh token in `HttpOnly` cookie
- TOTP bootstrap + backup code generation
- legacy Supabase JWT bridge behind `AUTH_ACCEPT_SUPABASE_TOKENS`

## API Endpoints

### Public

- `POST /api/auth/signup`
- `POST /api/auth/signin`
- `GET /api/auth/session`
- `POST /api/auth/refresh`
- `POST /api/auth/password/forgot`
- `POST /api/auth/otp/email/request`
- `POST /api/auth/otp/verify`
- `POST /api/auth/otp/resend`
- `POST /api/auth/magic-link`
- `GET /api/auth/magic-link/consume`
- `GET /api/auth/oauth/google/start`
- `GET /api/auth/oauth/google/callback`

### Authenticated

- `POST /api/auth/signout`
- `POST /api/auth/password/reset`
- `POST /api/auth/password/change`
- `GET /api/auth/sessions`
- `DELETE /api/auth/sessions/:sessionId`
- `POST /api/auth/sessions/revoke-all`
- `POST /api/auth/workspace/select`
- `POST /api/auth/2fa/totp/setup`
- `POST /api/auth/2fa/totp/enable`
- `POST /api/auth/2fa/totp/disable`
- `POST /api/auth/2fa/backup-codes/regenerate`

## OAuth Strategy

### Google

- backend-driven auth code flow
- Google callback lands on the backend
- backend exchanges code, links `OAuthAccount`, creates Axodesk session, then redirects to frontend

### Future providers

- add new `AuthProvider` entries
- reuse `OAuthAccount`
- add provider-specific authorize/token/userinfo adapters

## OTP and Magic Link

### Signup

1. Create or update `User`
2. Store password in `AuthCredential`
3. Issue `EmailVerificationToken`, `MagicLinkToken`, and `OtpCode`
4. Verify email with code or secure link
5. Mint Axodesk session

### Forgot password

1. Issue `PasswordResetToken`, `MagicLinkToken`, and `OtpCode`
2. Verify with code or link
3. Create short-lived authenticated session
4. Reset password and revoke other sessions

### Team invite

1. Create or reuse `User`
2. Add org/workspace memberships
3. Issue `MagicLinkToken` with tenant context
4. Redirect to `SetPassword` or dashboard depending on password state

## RBAC and Tenancy

- `JwtGuard` resolves session context from Redis or Postgres
- `RouteGuard` keeps existing org/workspace permission checks
- session carries `currentOrganizationId` and `currentWorkspaceId`
- workspace switching updates the server-side session and returns a new access token

## Migration Plan

### Phase 1

- deploy schema changes
- keep `AUTH_ACCEPT_SUPABASE_TOKENS=true`
- backend accepts both Axodesk and Supabase JWTs

### Phase 2

- ship frontend `authApi` replacement
- new sessions are Axodesk-native
- existing Supabase sessions remain valid until they expire

### Phase 3

- invite remaining users to reset password or use magic link
- create local `AuthCredential` on successful reset
- monitor `legacy_supabase` traffic in logs/audit stream

### Phase 4

- disable `AUTH_ACCEPT_SUPABASE_TOKENS`
- remove Supabase credentials entirely

## Password Migration

Direct password-hash migration from Supabase is not generally available. The supported path is:

- preserve `User.id`
- force first local password setup via reset/invite flow
- keep login available through legacy Supabase JWT bridge during rollout

## Deployment Topology

- NestJS API pods are stateless
- PostgreSQL stores durable auth state
- Redis handles cache, rate limits, and short-lived OAuth state
- SMTP provider handles email delivery
- load balancer terminates TLS and forwards `X-Forwarded-For`

## Monitoring and Alerts

### Metrics

- login success/failure rate
- refresh success rate
- refresh token reuse events
- OTP delivery and verify success rate
- magic link consumption rate
- auth latency p50/p95/p99
- Redis hit ratio for session cache

### Alerts

- sudden spike in `LoginAttemptResult.FAILURE`
- spike in `AuthAuditEvent.TOKEN_REUSE_DETECTED`
- refresh endpoint 5xx burst
- SMTP delivery failure burst
- Redis unavailable or session cache miss explosion

## Scale to Millions

- short JWT verification path with Redis-backed session lookup
- narrow indexes on session/token tables
- refresh tokens stored hashed and rotated
- partition `AuthAuditLog` and `LoginAttempt` by time once volumes justify it
- archive old refresh/audit rows with scheduled jobs
- keep session cache payload compact and avoid tenant joins on hot path

## Recommended Packages

- `argon2` for Argon2id hashing
- `jose` for JWT signing and verification
- `ioredis` for Redis
- `nodemailer` or SES/Mailgun provider abstraction for delivery
- future SSO: `passport-saml` or dedicated OIDC/SAML broker only when enterprise SSO is needed

## Testing Strategy

- unit tests for password policy, token rotation, TOTP verification, and rate limiting
- integration tests for `signup -> verify -> session`
- integration tests for `signin -> refresh rotation -> reuse detection`
- e2e tests for invite acceptance and workspace switching
- chaos tests around Redis outages and SMTP failures

## React SDK Example

```ts
import { authApi } from "./src/lib/authApi";

await authApi.signUp("Axo Admin", "owner@axodesk.com", "Stronger!Pass123");
await authApi.verifyOtp("123456", "owner@axodesk.com", "signup");
const { session } = await authApi.getSession();
await authApi.refreshSession();
authApi.onAuthStateChange((_user, nextSession) => {
  console.log("session changed", nextSession?.expires_at);
});
await authApi.signInWithGoogle();
```

## Angular SDK Example

```ts
import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class AxodeskAuthService {
  async signIn(email: string, password: string) {
    const res = await fetch('/api/auth/signin', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) throw new Error('Sign-in failed');
    return res.json();
  }

  async refreshSession(csrfToken: string) {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': csrfToken },
    });

    if (!res.ok) throw new Error('Refresh failed');
    return res.json();
  }
}
```

## Operational Notes

- `User` is preserved and remains the anchor for billing, memberships, notifications, and product ownership
- Supabase Auth is removed from the active path
- the only remaining Supabase touchpoint is the temporary JWT bridge, which can be disabled by config once migration finishes

