import { Router } from 'express'
import crypto from 'node:crypto'
import bcrypt from 'bcrypt'
import { OAuth2Client } from 'google-auth-library'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
import { hashToken, signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/auth.js'
import { sendMail } from '../lib/services.js'
import { env } from '../config/env.js'
import { redis } from '../lib/redis.js'
import { otpRateLimit, oauthRateLimit } from '../lib/rate-limits.js'
import { findStorefrontTenant } from '../utils/storefront-tenant.js'
import { assertSubscriptionCapacity } from '../lib/subscription.js'

const router = Router()
const credentials = z.object({ email: z.email(), password: z.string().min(8) })
const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID)
const publicUser = (user: { id: string; name: string; email: string; role: string; tenant: string; phone: string | null; avatar: string | null; emailVerified: Date | null; platformAdmin: boolean }) => ({ id: user.id, name: user.name, email: user.email, role: user.role[0] + user.role.slice(1).toLowerCase(), tenant: user.tenant, phone: user.phone ?? undefined, avatar: user.avatar ?? undefined, emailVerified: Boolean(user.emailVerified), platformAdmin: user.platformAdmin })
const randomToken = () => crypto.randomBytes(32).toString('hex')
const normalizePhone = (value: string) => value.replace(/[^0-9+]/g, '')
const oauthErrorCode = (error: unknown) => {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('configuration missing')) return 'not_configured'
  if (message.includes('state')) return 'invalid_state'
  if (message.includes('Redis')) return 'temporarily_unavailable'
  if (message.includes('Facebook')) return 'facebook_failed'
  return 'oauth_failed'
}

router.post('/phone/request', otpRateLimit, async (req, res) => {
  const parsed = z.object({ phone: z.string().min(8).max(20) }).parse(req.body), phone = normalizePhone(parsed.phone)
  const user = await prisma.user.findFirst({ where: { phone } })
  if (!user) return res.status(404).json({ message: 'Энэ утасны дугаартай бүртгэл олдсонгүй.' })
  await prisma.otpChallenge.deleteMany({ where: { phone, verifiedAt: null } })
  const code = String(crypto.randomInt(100000, 999999))
  const challenge = await prisma.otpChallenge.create({ data: { phone, codeHash: await bcrypt.hash(code, 10), expiresAt: new Date(Date.now() + 5 * 60_000) } })
  // Production SMS provider нь OTP-г эндээс илгээнэ; API response-д код задрахгүй.
  res.status(201).json({ challengeId: challenge.id, expiresIn: 300, ...(env.NODE_ENV !== 'production' ? { devCode: code } : {}) })
})

router.post('/phone/register/request', otpRateLimit, async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2), phone: z.string().min(8).max(20) }).parse(req.body), phone = normalizePhone(input.phone)
  if (await prisma.user.findUnique({ where: { phone } })) return res.status(409).json({ message: 'Энэ утасны дугаар бүртгэлтэй байна. Нэвтрэх хэсгийг ашиглана уу.' })
  await prisma.otpChallenge.deleteMany({ where: { phone, verifiedAt: null } })
  const code = String(crypto.randomInt(100000, 999999)), challenge = await prisma.otpChallenge.create({ data: { phone, codeHash: await bcrypt.hash(code, 10), expiresAt: new Date(Date.now() + 5 * 60_000) } })
  res.status(201).json({ challengeId: challenge.id, expiresIn: 300, ...(env.NODE_ENV !== 'production' ? { devCode: code } : {}) })
})

router.post('/phone/register/verify', otpRateLimit, async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2), challengeId: z.string(), code: z.string().length(6) }).parse(req.body)
  const challenge = await prisma.otpChallenge.findUnique({ where: { id: input.challengeId } })
  if (!challenge || challenge.verifiedAt || challenge.expiresAt < new Date() || challenge.attempts >= 5) return res.status(400).json({ message: 'OTP хүчингүй эсвэл хугацаа дууссан.' })
  await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } })
  if (!await bcrypt.compare(input.code, challenge.codeHash)) return res.status(400).json({ message: 'OTP код буруу.' })
  if (await prisma.user.findUnique({ where: { phone: challenge.phone } })) return res.status(409).json({ message: 'Энэ дугаар бүртгэлтэй байна.' })
  const tenant = await findStorefrontTenant(req.hostname); if (!tenant) return res.status(503).json({ message: 'Үйлчилгээний байгууллага тохируулагдаагүй байна.' })
  await prisma.$transaction((tx) => assertSubscriptionCapacity(tx, tenant.id, 'users'))
  const email = `phone-${challenge.phone.replace(/\D/g, '')}@phone.tradeflow.local`
  const user = await prisma.$transaction(async (tx) => { const created = await tx.user.create({ data: { name: input.name, phone: challenge.phone, email, emailVerified: new Date(), role: 'CUSTOMER', tenant: tenant.name, tenantId: tenant.id } }); await tx.otpChallenge.update({ where: { id: challenge.id }, data: { verifiedAt: new Date() } }); return created })
  const tokens = await issueTokens(user)
  res.status(201).json({ user: publicUser(user), token: tokens.accessToken, ...tokens })
})

router.post('/phone/verify', otpRateLimit, async (req, res) => {
  const input = z.object({ challengeId: z.string(), code: z.string().length(6) }).parse(req.body)
  const challenge = await prisma.otpChallenge.findUnique({ where: { id: input.challengeId } })
  if (!challenge || challenge.verifiedAt || challenge.expiresAt < new Date() || challenge.attempts >= 5) return res.status(400).json({ message: 'OTP хүчингүй эсвэл хугацаа дууссан.' })
  await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } })
  if (!await bcrypt.compare(input.code, challenge.codeHash)) return res.status(400).json({ message: 'OTP код буруу.' })
  const user = await prisma.user.findFirst({ where: { phone: challenge.phone } })
  if (!user) return res.status(404).json({ message: 'Хэрэглэгч олдсонгүй.' })
  await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { verifiedAt: new Date() } })
  const tokens = await issueTokens(user)
  res.json({ user: publicUser(user), token: tokens.accessToken, ...tokens })
})

router.post('/guest', async (req, res) => {
  const { guestId } = z.object({ guestId: z.string().min(8).max(100) }).parse(req.body)
  const tenant = await findStorefrontTenant(req.hostname)
  if (!tenant) return res.status(503).json({ message: 'Худалдааны орчин тохируулагдаагүй байна.' })
  const email = `guest-${guestId.replace(/[^a-zA-Z0-9-]/g, '')}@guest.tradeflow.local`
  const user = await prisma.user.upsert({ where: { email }, update: { tenantId: tenant.id }, create: { name: 'Зочин хэрэглэгч', email, role: 'CUSTOMER', tenant: tenant.name, tenantId: tenant.id } })
  const tokens = await issueTokens(user)
  res.json({ user: publicUser(user), token: tokens.accessToken, ...tokens })
})

router.post('/accept-invite', async (req, res) => {
  const input = z.object({ token: z.string().min(32), password: z.string().min(8) }).parse(req.body)
  const tokenHash = hashToken(input.token)
  const passwordHash = await bcrypt.hash(input.password, 12)
  const user = await prisma.$transaction(async (tx) => {
    const invitation = await tx.staffInvitation.findUnique({ where: { tokenHash } })
    if (!invitation || invitation.acceptedAt || invitation.expiresAt < new Date()) throw Object.assign(new Error('Урилга хүчингүй эсвэл хугацаа дууссан байна.'), { status: 400 })
    const tenant = await tx.tenant.findUnique({ where: { id: invitation.tenantId } })
    if (!tenant?.active) throw Object.assign(new Error('Урилгын байгууллага идэвхгүй байна.'), { status: 409 })
    const existingUser = await tx.user.findUnique({ where: { email: invitation.email } })
    if (existingUser) throw Object.assign(new Error('Энэ email-ээр хэрэглэгч аль хэдийн бүртгэлтэй байна. Нэвтрэх эсвэл админтай холбогдоно уу.'), { status: 409 })
    const created = await tx.user.create({ data: { name: invitation.name, email: invitation.email, role: invitation.role, tenantId: tenant.id, tenant: tenant.name, passwordHash, emailVerified: new Date() } })
    await tx.staffInvitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } })
    return created
  })
  const tokens = await issueTokens(user)
  res.json({ user: publicUser(user), token: tokens.accessToken, ...tokens })
})

async function issueTokens(user: { id: string; email: string; role: 'ADMIN' | 'MANAGER' | 'EMPLOYEE' | 'VENDOR' | 'TRANSPORTER' | 'ACCOUNTANT' | 'CUSTOMER'; tenantId?: string | null }) {
  const payload = { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId ?? undefined }
  const accessToken = signAccessToken(payload)
  const refreshToken = signRefreshToken(payload)
  const decoded = verifyRefreshToken(refreshToken)
  await prisma.refreshToken.create({ data: { tokenHash: hashToken(refreshToken), userId: user.id, expiresAt: new Date((decoded.exp ?? 0) * 1000) } })
  return { accessToken, refreshToken }
}

async function findOrCreateOAuthUser(provider: string, providerUserId: string, profile: { email: string; name: string; avatar?: string }) {
  const email = profile.email.trim().toLowerCase()
  const hasProviderEmail = !email.endsWith('@oauth.tradeflow.local')
  const linked = await prisma.oAuthAccount.findUnique({ where: { provider_providerUserId: { provider, providerUserId } }, include: { user: true } })
  if (linked) {
    if (!hasProviderEmail) {
      if (linked.user.email.endsWith('@oauth.tradeflow.local')) throw new Error(`${provider === 'facebook' ? 'Facebook' : provider} verified email is required`)
      return linked.user
    }
    const emailOwner = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })
    if (!emailOwner || emailOwner.id === linked.userId) {
      return prisma.user.update({ where: { id: linked.userId }, data: { emailVerified: linked.user.emailVerified ?? new Date(), avatar: linked.user.avatar ?? profile.avatar } })
    }
    return prisma.$transaction(async (tx) => {
      await tx.oAuthAccount.deleteMany({ where: { provider, userId: emailOwner.id, id: { not: linked.id } } })
      await tx.oAuthAccount.update({ where: { id: linked.id }, data: { userId: emailOwner.id } })
      return tx.user.update({ where: { id: emailOwner.id }, data: { emailVerified: emailOwner.emailVerified ?? new Date(), avatar: emailOwner.avatar ?? profile.avatar } })
    })
  }
  if (!hasProviderEmail) throw new Error(`${provider === 'facebook' ? 'Facebook' : provider} verified email is required`)
  const existing = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })
  const defaultTenant = await findStorefrontTenant()
  if (!defaultTenant) throw new Error('No active organization is configured')
  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: { emailVerified: existing.emailVerified ?? new Date(), avatar: existing.avatar ?? profile.avatar } })
    : await prisma.user.create({ data: { name: profile.name, email, emailVerified: new Date(), avatar: profile.avatar, role: 'CUSTOMER', tenant: defaultTenant.name, tenantId: defaultTenant.id } })
  await prisma.oAuthAccount.create({ data: { provider, providerUserId, userId: user.id } })
  return user
}

router.post('/register', async (req, res) => {
  const input = credentials.extend({ name: z.string().min(2) }).parse(req.body)
  if (await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } })) return res.status(409).json({ message: 'Энэ имэйл бүртгэлтэй байна.' })
  const tenant = await findStorefrontTenant(req.hostname)
  if (!tenant) return res.status(503).json({ message: 'Үйлчилгээний байгууллага тохируулагдаагүй байна.' })
  const user = await prisma.user.create({ data: { name: input.name, email: input.email.toLowerCase(), passwordHash: await bcrypt.hash(input.password, 12), tenant: tenant.name, tenantId: tenant.id, role: 'CUSTOMER' } })
  const tokens = await issueTokens(user)
  const verificationToken = randomToken()
  await prisma.emailVerificationToken.create({ data: { tokenHash: hashToken(verificationToken), userId: user.id, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } })
  void sendMail(user.email, 'FreshFlow имэйл баталгаажуулах', `<h2>Сайн байна уу, ${user.name}</h2><p><a href="${env.AUTH_CALLBACK_URL}?type=verify-email&token=${verificationToken}">Имэйлээ баталгаажуулах</a></p>`)
  res.status(201).json({ user: publicUser(user), token: tokens.accessToken, ...tokens })
})

router.post('/login', async (req, res) => {
  const input = credentials.parse(req.body)
  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } })
  if (!user?.passwordHash || !await bcrypt.compare(input.password, user.passwordHash)) return res.status(401).json({ message: 'Имэйл эсвэл нууц үг буруу.' })
  const tokens = await issueTokens(user)
  res.json({ user: publicUser(user), token: tokens.accessToken, ...tokens })
})

router.post('/refresh', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body)
  try {
    const payload = verifyRefreshToken(refreshToken)
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(refreshToken) } })
    if (!stored || stored.expiresAt < new Date()) return res.status(401).json({ message: 'Refresh token хүчингүй.' })
    await prisma.refreshToken.delete({ where: { id: stored.id } })
    const tokens = await issueTokens(payload)
    res.json(tokens)
  } catch { res.status(401).json({ message: 'Refresh token хүчингүй.' }) }
})

router.post('/logout', async (req, res) => { const input = z.object({ refreshToken: z.string().optional() }).parse(req.body); if (input.refreshToken) await prisma.refreshToken.deleteMany({ where: { tokenHash: hashToken(input.refreshToken) } }); res.status(204).send() })
router.get('/me', authenticate, async (req, res) => { const user = await prisma.user.findUnique({ where: { id: req.user!.id } }); user ? res.json(publicUser(user)) : res.status(404).json({ message: 'Хэрэглэгч олдсонгүй.' }) })
router.patch('/me', authenticate, async (req, res) => {
  const input = z.object({ name: z.string().min(2).max(100).optional(), phone: z.string().max(30).nullable().optional(), company: z.string().min(2).max(100).optional() }).parse(req.body)
  const current = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } })
  if (input.company && current.role !== 'ADMIN') return res.status(403).json({ message: 'Байгууллагын нэрийг зөвхөн админ өөрчилнө.' })
  if (input.company && current.tenantId) await prisma.$transaction([
    prisma.tenant.update({ where: { id: current.tenantId }, data: { name: input.company } }),
    prisma.user.updateMany({ where: { tenantId: current.tenantId }, data: { tenant: input.company } }),
  ])
  const user = await prisma.user.update({ where: { id: current.id }, data: { name: input.name, phone: input.phone } })
  res.json(publicUser(user))
})
router.patch('/me/password', authenticate, async (req, res) => {
  const input = z.object({ currentPassword: z.string().min(8), newPassword: z.string().min(8) }).parse(req.body)
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } })
  if (!user.passwordHash || !await bcrypt.compare(input.currentPassword, user.passwordHash)) return res.status(400).json({ message: 'Одоогийн нууц үг буруу байна.' })
  await prisma.$transaction([prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(input.newPassword, 12) } }), prisma.refreshToken.deleteMany({ where: { userId: user.id } })])
  res.json({ message: 'Нууц үг амжилттай солигдлоо.' })
})

router.post('/oauth/google', async (req, res) => {
  if (!env.GOOGLE_CLIENT_ID) return res.status(503).json({ message: 'Google OAuth тохиргоо хийгдээгүй.' })
  const { credential } = z.object({ credential: z.string().min(20) }).parse(req.body)
  const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: env.GOOGLE_CLIENT_ID })
  const profile = ticket.getPayload()
  if (!profile?.sub || !profile.email || !profile.email_verified) return res.status(401).json({ message: 'Google бүртгэл баталгаажаагүй.' })
  const user = await findOrCreateOAuthUser('google', profile.sub, { email: profile.email, name: profile.name ?? profile.email.split('@')[0]!, avatar: profile.picture })
  const tokens = await issueTokens(user)
  res.json({ user: publicUser(user), token: tokens.accessToken, ...tokens })
})

router.get('/oauth/:provider/start', oauthRateLimit, async (req, res) => {
  const provider = z.enum(['google', 'github', 'facebook']).parse(req.params.provider)
  const config = provider === 'google'
    ? { clientId: env.GOOGLE_CLIENT_ID, callback: `${env.BACKEND_PUBLIC_URL}/api/v1/auth/oauth/google/callback` }
    : provider === 'github'
      ? { clientId: env.GITHUB_CLIENT_ID, callback: `${env.BACKEND_PUBLIC_URL}/api/v1/auth/oauth/github/callback` }
      : { clientId: env.FACEBOOK_CLIENT_ID, callback: `${env.BACKEND_PUBLIC_URL}/api/v1/auth/oauth/facebook/callback` }
  if (!config.clientId) return res.status(503).json({ message: `${provider} OAuth тохиргоо хийгдээгүй.` })
  const state = jwt.sign({ provider, nonce: randomToken() }, env.JWT_ACCESS_SECRET, { expiresIn: '10m' })
  const url = provider === 'google'
    ? `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(config.clientId)}&redirect_uri=${encodeURIComponent(config.callback)}&response_type=code&scope=openid%20email%20profile&access_type=offline&prompt=select_account%20consent&state=${encodeURIComponent(state)}`
    : provider === 'github'
      ? `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(config.clientId)}&redirect_uri=${encodeURIComponent(config.callback)}&scope=read:user%20user:email&state=${encodeURIComponent(state)}`
      : `https://www.facebook.com/dialog/oauth?client_id=${encodeURIComponent(config.clientId)}&redirect_uri=${encodeURIComponent(config.callback)}&response_type=code&scope=email&state=${encodeURIComponent(state)}`
  res.redirect(url)
})

router.get('/oauth/:provider/callback', oauthRateLimit, async (req, res) => {
  // Facebook's link-preview crawler may follow the callback URL before the
  // user's browser and consume the single-use authorization code. Never run
  // OAuth state verification or code exchange for crawler requests.
  const userAgent = req.headers['user-agent'] ?? ''
  if (userAgent.includes('facebookexternalhit') || userAgent.includes('Facebot')) {
    return res.status(200).send('OK')
  }

  const provider = z.enum(['google', 'github', 'facebook']).parse(req.params.provider)
  try {
    const providerError = z.object({ error: z.string(), error_reason: z.string().optional() }).safeParse(req.query)
    if (providerError.success) {
      const callbackUrl = new URL(env.AUTH_CALLBACK_URL)
      callbackUrl.searchParams.set('error', providerError.data.error === 'access_denied' || providerError.data.error_reason === 'user_denied' ? 'access_denied' : `${provider}_failed`)
      return res.redirect(callbackUrl.toString())
    }
    const { code, state } = z.object({ code: z.string(), state: z.string() }).parse(req.query)
    const statePayload = jwt.verify(state, env.JWT_ACCESS_SECRET) as { provider: string }
    if (statePayload.provider !== provider) throw new Error('OAuth state mismatch')
    let profile: { id: string; email: string; name: string; avatar?: string }
    if (provider === 'google') {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error('Google OAuth configuration missing')
      const callback = `${env.BACKEND_PUBLIC_URL}/api/v1/auth/oauth/google/callback`
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: callback, grant_type: 'authorization_code' }) })
      const tokenData = await tokenResponse.json() as { id_token?: string }
      if (!tokenData.id_token) throw new Error('Google token exchange failed')
      const ticket = await googleClient.verifyIdToken({ idToken: tokenData.id_token, audience: env.GOOGLE_CLIENT_ID })
      const google = ticket.getPayload()
      if (!google?.sub || !google.email || !google.email_verified) throw new Error('Verified Google email is required')
      profile = { id: google.sub, email: google.email, name: google.name ?? google.email.split('@')[0]!, avatar: google.picture }
    } else if (provider === 'github') {
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) throw new Error('GitHub OAuth configuration missing')
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }) })
      const tokenData = await tokenResponse.json() as { access_token?: string }
      if (!tokenData.access_token) throw new Error('GitHub token exchange failed')
      const headers = { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'TradeFlow' }
      const [userResponse, emailResponse] = await Promise.all([fetch('https://api.github.com/user', { headers }), fetch('https://api.github.com/user/emails', { headers })])
      const githubUser = await userResponse.json() as { id: number; login: string; name?: string; avatar_url?: string; email?: string }
      const emails = await emailResponse.json() as Array<{ email: string; primary: boolean; verified: boolean }>
      const email = githubUser.email ?? emails.find((item) => item.primary && item.verified)?.email ?? emails.find((item) => item.verified)?.email
      if (!email) throw new Error('Verified GitHub email is required')
      profile = { id: String(githubUser.id), email, name: githubUser.name ?? githubUser.login, avatar: githubUser.avatar_url }
    } else {
      if (!env.FACEBOOK_CLIENT_ID || !env.FACEBOOK_CLIENT_SECRET) throw new Error('Facebook OAuth configuration missing')
      const callback = `${env.BACKEND_PUBLIC_URL}/api/v1/auth/oauth/facebook/callback`
      const tokenResponse = await fetch('https://graph.facebook.com/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.FACEBOOK_CLIENT_ID, client_secret: env.FACEBOOK_CLIENT_SECRET, redirect_uri: callback, code }),
      })
      const tokenData = await tokenResponse.json() as { access_token?: string; error?: { message?: string } }
      if (!tokenResponse.ok || !tokenData.access_token) throw new Error(`Facebook token exchange failed: ${tokenData.error?.message ?? tokenResponse.status}`)
      const proof = crypto.createHmac('sha256', env.FACEBOOK_CLIENT_SECRET).update(tokenData.access_token).digest('hex')
      const profileUrl = new URL('https://graph.facebook.com/me')
      profileUrl.search = new URLSearchParams({ fields: 'id,name,email,picture.type(large)', appsecret_proof: proof }).toString()
      const profileResponse = await fetch(profileUrl, { headers: { Authorization: `Bearer ${tokenData.access_token}` } })
      const facebook = await profileResponse.json() as { id?: string; name?: string; email?: string; picture?: { data?: { url?: string } }; error?: { message?: string } }
      if (!profileResponse.ok || !facebook.id || !facebook.name) throw new Error(`Facebook profile failed: ${facebook.error?.message ?? profileResponse.status}`)
      profile = { id: facebook.id, email: facebook.email ?? `facebook-${facebook.id}@oauth.tradeflow.local`, name: facebook.name, avatar: facebook.picture?.data?.url }
    }
    const user = await findOrCreateOAuthUser(provider, profile.id, profile)
    const tokens = await issueTokens(user)
    const exchangeCode = randomToken()
    if (redis.status !== 'ready') throw new Error('Redis is required for OAuth exchange')
    await redis.set(`oauth:exchange:${exchangeCode}`, JSON.stringify({ user: publicUser(user), token: tokens.accessToken, ...tokens }), 'EX', 120)
    res.redirect(`${env.AUTH_CALLBACK_URL}?code=${encodeURIComponent(exchangeCode)}`)
  } catch (error) {
    console.error(error)
    const callbackUrl = new URL(env.AUTH_CALLBACK_URL)
    callbackUrl.searchParams.set('error', oauthErrorCode(error))
    res.redirect(callbackUrl.toString())
  }
})

router.post('/oauth/exchange', oauthRateLimit, async (req, res) => {
  const { code } = z.object({ code: z.string().min(32) }).parse(req.body)
  if (redis.status !== 'ready') return res.status(503).json({ message: 'OAuth exchange түр боломжгүй.' })
  const key = `oauth:exchange:${code}`
  const value = await redis.get(key)
  if (!value) return res.status(400).json({ message: 'OAuth code хүчингүй эсвэл ашиглагдсан.' })
  await redis.del(key)
  res.json(JSON.parse(value))
})

router.post('/verify-email', async (req, res) => {
  const { token } = z.object({ token: z.string().min(32) }).parse(req.body)
  const record = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(token) } })
  if (!record || record.expiresAt < new Date()) return res.status(400).json({ message: 'Баталгаажуулах холбоос хүчингүй эсвэл хугацаа дууссан.' })
  await prisma.$transaction([prisma.user.update({ where: { id: record.userId }, data: { emailVerified: new Date() } }), prisma.emailVerificationToken.deleteMany({ where: { userId: record.userId } })])
  res.json({ message: 'Имэйл амжилттай баталгаажлаа.' })
})

router.post('/forgot-password', async (req, res) => {
  const { email } = z.object({ email: z.email() }).parse(req.body)
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
  if (user) {
    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } })
    const token = randomToken()
    await prisma.passwordResetToken.create({ data: { tokenHash: hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + 30 * 60 * 1000) } })
    void sendMail(user.email, 'TradeFlow нууц үг сэргээх', `<p><a href="${env.AUTH_CALLBACK_URL}?type=reset-password&token=${token}">Нууц үгээ сэргээх</a></p><p>Энэ холбоос 30 минут хүчинтэй.</p>`)
  }
  res.json({ message: 'Хэрэв бүртгэлтэй имэйл бол сэргээх холбоос илгээгдлээ.' })
})

router.post('/reset-password', async (req, res) => {
  const input = z.object({ token: z.string().min(32), password: z.string().min(8) }).parse(req.body)
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(input.token) } })
  if (!record || record.usedAt || record.expiresAt < new Date()) return res.status(400).json({ message: 'Сэргээх холбоос хүчингүй эсвэл хугацаа дууссан.' })
  await prisma.$transaction([prisma.user.update({ where: { id: record.userId }, data: { passwordHash: await bcrypt.hash(input.password, 12) } }), prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }), prisma.refreshToken.deleteMany({ where: { userId: record.userId } })])
  res.json({ message: 'Нууц үг амжилттай шинэчлэгдлээ.' })
})

export default router
