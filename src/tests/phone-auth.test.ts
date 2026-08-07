import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { app } from '../app.js'
import { prisma } from '../lib/prisma.js'

const stamp = `${Date.now()}${Math.floor(Math.random() * 10000)}`, phone = `99${stamp.slice(-6)}`
let tenantId = '', userId = ''
beforeAll(async () => { const tenant = await prisma.tenant.create({ data: { name: `Phone ${stamp}`, slug: `tradeflow`, active: true } }).catch(() => prisma.tenant.findFirstOrThrow({ where: { slug: 'tradeflow' } })); tenantId = tenant.id })
afterAll(async () => { await prisma.refreshToken.deleteMany({ where: { userId } }); await prisma.otpChallenge.deleteMany({ where: { phone } }); if (userId) await prisma.user.delete({ where: { id: userId } }); await prisma.$disconnect() })

describe('phone OTP registration and login', () => {
  it('registers a new customer after verifying the phone OTP', async () => {
    const requested = await request(app).post('/api/v1/auth/phone/register/request').send({ name: 'OTP Customer', phone }).expect(201)
    expect(requested.body.challengeId).toBeTruthy(); expect(requested.body.devCode).toMatch(/^\d{6}$/)
    const verified = await request(app).post('/api/v1/auth/phone/register/verify').send({ name: 'OTP Customer', challengeId: requested.body.challengeId, code: requested.body.devCode }).expect(201)
    expect(verified.body.token).toBeTruthy(); expect(verified.body.user.phone).toBe(phone); expect(verified.body.user.role).toBe('Customer'); userId = verified.body.user.id
    const saved = await prisma.user.findUniqueOrThrow({ where: { phone } }); expect(saved.tenantId).toBe(tenantId)
  })
  it('logs the same customer in with a fresh OTP and rejects duplicate registration', async () => {
    await request(app).post('/api/v1/auth/phone/register/request').send({ name: 'Duplicate', phone }).expect(409)
    const requested = await request(app).post('/api/v1/auth/phone/request').send({ phone }).expect(201)
    const verified = await request(app).post('/api/v1/auth/phone/verify').send({ challengeId: requested.body.challengeId, code: requested.body.devCode }).expect(200)
    expect(verified.body.user.id).toBe(userId); expect(verified.body.token).toBeTruthy()
  })
})
