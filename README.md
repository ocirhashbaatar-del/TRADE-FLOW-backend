# TradeFlow Backend

Node.js + Express + TypeScript backend using PostgreSQL/Prisma, JWT, bcrypt, Socket.IO, Redis, Cloudinary, Stripe, Nodemailer and Swagger.

## Start locally

1. Copy `.env.example` to `.env` and replace secrets.
2. Start PostgreSQL and Redis: `docker compose up -d`.
3. Install: `npm install`.
4. Generate Prisma Client: `npm run prisma:generate`.
5. Migrate: `npm run prisma:migrate -- --name init`.
6. Seed: `npm run prisma:seed`.
7. Run: `npm run dev`.

## Images and deployment

Image binaries live in Cloudinary; PostgreSQL stores their stable key, Cloudinary URL/public ID, mime type, size and dimensions in the `Asset` table. This keeps database backups small while making deployments independent from the frontend filesystem.

After configuring the three `CLOUDINARY_*` variables, import every image from `Supply/public/images`:

```bash
npm run assets:sync
```

The command is idempotent: it overwrites the same Cloudinary public ID, upserts PostgreSQL metadata, and replaces seeded product image paths with Cloudinary URLs. Frontend static images resolve through `GET /api/v1/assets/:key`; the endpoint is Redis-cached and redirects to Cloudinary CDN.

API base: `http://localhost:4000/api/v1`  
Swagger: `http://localhost:4000/api/docs`

Frontend env: `VITE_API_URL=http://localhost:4000/api/v1`

## Authentication

- Local register/login with bcrypt password hashing
- Short-lived JWT access token and rotating refresh token
- Google OAuth: frontend obtains a Google Identity credential and sends `{ "credential": "..." }` to `POST /api/v1/auth/oauth/google`
- Email verification: `POST /api/v1/auth/verify-email`
- Forgot/reset password: `POST /api/v1/auth/forgot-password` and `POST /api/v1/auth/reset-password`
- OAuth account linking by verified email
- Auth-specific rate limiting and refresh-token revocation

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from a Google Web OAuth client. Add this Authorized Redirect URI:

`http://localhost:4000/api/v1/auth/oauth/google/callback`

For GitHub OAuth, create an OAuth App and set its callback URL to:

`http://localhost:4000/api/v1/auth/oauth/github/callback`

For Facebook Login, add this Valid OAuth Redirect URI:

`http://localhost:4000/api/v1/auth/oauth/facebook/callback`

Configure `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET`, and `BACKEND_PUBLIC_URL`. Facebook/GitHub callbacks create a two-minute, single-use exchange code in Redis; access and refresh tokens are never placed in a redirect URL.

Cloudinary, Stripe and SMTP integrations return a configuration error or skip email when their environment keys are absent. Redis gracefully falls back to uncached database queries when unavailable.
