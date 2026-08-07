# TradeFlow — Production Environment Variable Matrix

**12.1 Release Candidate • Owner registry & rotation**

This document is the single source of truth for every environment variable the
backend reads. All variables are validated at startup by `backend/src/config/env.ts`.

## Conventions

- **Owner** = role responsible for the value's correctness and rotation.
- **Rotation** = how often secrets must be regenerated and how.
- **Required** = startup fails if missing/empty.
- **Optional** = feature is disabled / gracefully skipped when absent.

## Core

| Variable | Required | Owner | Rotation | Notes |
|---|---|---|---|---|
| `NODE_ENV` | Yes | Platform Admin | — | `development`/`test`/`production` |
| `PORT` | No | DevOps | — | Default `4000` |
| `DTABASE_URL` | Yes | DevOps | pg password each rotation | Postgres connection string |
| `FRONTEND_URL` | Yes | DevOps | — | CORS allowlist (comma-separated origins) |
| `BACKEND_PUBLIC_URL` | Yes | DevOps | — | Public base for callbacks |

## Auth & tokens

| Variable | Required | Owner | Rotation | Notes |
|---|---|---|---|---|
| `JWT_ACCESS_SECRET` | Yes | Security | 90 days | ≥32 chars |
| `JWT_REFRESH_SECRET` | Yes | Security | 90 days | ≥32 chars |
| `JWT_ACCESS_EXPIRES` | No | Security | — | Default `15m` |
| `JWT_REFRESH_EXPIRES` | No | Security | — | Default `7d` |
| `AUTH_CALLBACK_URL` | No | DevOps | — | OAuth/email redirect target |

## Identity providers (OAuth)

| Variable | Required | Owner | Rotation | Notes |
|---|---|---|---|---|
| `GOOGLE_CLIENT_ID` | No | Tenant Admin | — | Disables Google OAuth if absent |
| `GOOGLE_CLIENT_SECRET` | No | Tenant Admin | 180 days | |
| `GITHUB_CLIENT_ID` | No | Tenant Admin | — | |
| `GITHUB_CLIENT_SECRET` | No | Tenant Admin | 180 days | |
| `FACEBOOK_CLIENT_ID` | No | Tenant Admin | — | |
| `FACEBOOK_CLIENT_SECRET` | No | Tenant Admin | 180 days | |

## Payments

| Variable | Required | Owner | Rotation | Notes |
|---|---|---|---|---|
| `STRIPE_SECRET_KEY` | No | Finance | 180 days | Stripe provider optional (feature flag) |
| `STRIPE_WEBHOOK_SECRET` | No | Finance | 180 days | |
| `QPAY_BASE_URL` | No | Finance | — | Sandbox default |
| `QPAY_CLIENT_ID` | No | Finance | 180 days | QPay provider optional (feature flag) |
| `QPAY_CLIENT_SECRET` | No | Finance | 180 days | |
| `QPAY_INVOICE_CODE` | No | Finance | — | |
| `QPAY_CALLBACK_TOKEN` | No | Finance | 90 days | ≥24 chars; callback auth |

## Email / SMS

| Variable | Required | Owner | Rotation | Notes |
|---|---|---|---|---|
| `SMTP_HOST` | No | Tenant Admin | — | Disables email if absent |
| `SMTP_PORT` | No | Tenant Admin | — | Default `587` |
| `SMTP_USER` | No | Tenant Admin | 180 days | |
| `SMTP_PASS` | No | Tenant Admin | 180 days | |
| `MAIL_FROM` | No | Tenant Admin | — | Default `TradeFlow <noreply@tradeflow.mn>` |

## Storage / assets

| Variable | Required | Owner | Rotation | Notes |
|---|---|---|---|---|
| `CLOUDINARY_CLOUD_NAME` | No | Tenant Admin | — | Disables image upload if absent |
| `CLOUDINARY_API_KEY` | No | Tenant Admin | 180 days | |
| `CLOUDINARY_API_SECRET` | No | Tenant Admin | 180 days | |
| `ASSET_SOURCE_DIR` | No | DevOps | — | Default `../Supply/public/images` |

## Infra / observability

| Variable | Required | Owner | Rotation | Notes |
|---|---|---|---|---|
| `REDIS_URL` | No | DevOps | — | Graceful fallback to no-cache if down |
| `SENTRY_DSN` | No | DevOps | — | Optional error tracking |

## Deployment / seed

| Variable | Required | Owner | Rotation | Notes |
|---|---|---|---|---|
| `SEED_PRODUCTION_ALLOWED` | No | Platform Admin | — | Must stay `false` in production; demo seed refuses to run otherwise |

## Feature flags (12.1 / 12.8)

| Variable | Required | Owner | Default | Notes |
|---|---|---|---|---|
| `FEATURE_FLAG_STRIPE` | No | Platform Admin | `true` | Disable during pilot if Stripe decision pending |
| `FEATURE_FLAG_OAUTH` | No | Platform Admin | `true` | |
| `FEATURE_FLAG_QPAY` | No | Platform Admin | `true` | |
| `FEATURE_FLAG_E_BARIMT` | No | Platform Admin | `true` | Phase-2 tax integration |
| `FEATURE_FLAG_DELIVERY_PARTNER` | No | Platform Admin | `false` | External partner adapter |

## Vercel domain attach (12.3)

| Variable | Required | Owner | Rotation | Notes |
|---|---|---|---|---|
| `VERCEL_TOKEN` | No | Platform Admin | 180 days | Used by `attachVercelDomain` |
| `VERCEL_PROJECT_ID` | No | Platform Admin | — | |
| `VERCEL_TEAM_ID` | No | Platform Admin | — | Optional |

## Secret handling rules

1. Never commit secrets; keep them in the platform secret store (Render env / Vercel env).
2. On rotation, rotate the secret and immediately verify the dependent integration
   (login, QPay, SMTP, OAuth) with a single smoke test.
3. Record every rotation in the tenant/internal audit log with date, owner, variable.
4. Access tokens (JWT) are short-lived; refresh rotation is automatic (12.4).
