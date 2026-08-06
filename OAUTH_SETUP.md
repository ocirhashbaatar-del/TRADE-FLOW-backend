# OAuth provider setup

Never commit or send client secrets in chat. Store them only in `backend/.env` and in the deployment provider's secret manager.

## Local URLs

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`
- Frontend callback: `http://localhost:5173/auth/callback`

## Google Cloud Console

Create an OAuth 2.0 Client ID with application type **Web application**.

- Authorized JavaScript origin: `http://localhost:5173`
- Authorized redirect URI: `http://localhost:4000/api/v1/auth/oauth/google/callback`
- Copy the Client ID to `GOOGLE_CLIENT_ID`
- Copy the Client Secret to `GOOGLE_CLIENT_SECRET`

## GitHub Developer Settings

Create a new OAuth App.

- Homepage URL: `http://localhost:5173`
- Authorization callback URL: `http://localhost:4000/api/v1/auth/oauth/github/callback`
- Copy values to `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`

## Meta for Developers

Create an app, add **Facebook Login**, and configure:

- App domain for local testing: `localhost`
- Valid OAuth Redirect URI: `http://localhost:4000/api/v1/auth/oauth/facebook/callback`
- Enable client OAuth login and web OAuth login
- Request `email` and `public_profile`
- Copy values to `FACEBOOK_CLIENT_ID` and `FACEBOOK_CLIENT_SECRET`

## Backend environment

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
FACEBOOK_CLIENT_ID=
FACEBOOK_CLIENT_SECRET=
BACKEND_PUBLIC_URL=http://localhost:4000
AUTH_CALLBACK_URL=http://localhost:5173/auth/callback
```

Redis must be running because callback results are exchanged through a two-minute, single-use Redis code.

## Production

Replace localhost URLs with HTTPS production URLs in both provider consoles and environment variables. Keep development and production OAuth applications separate where possible.

