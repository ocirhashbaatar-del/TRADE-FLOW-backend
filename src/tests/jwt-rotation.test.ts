import request from 'supertest'
import bcrypt from 'bcrypt'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { app } from '../app.js'
import { hashToken } from '../utils/auth.js'

// 12.4 — JWT refresh rotation: each refresh revokes the old token and issues a new
// one; reusing/revoking the old refresh must fail and close the token family.
const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
let userId = '', accessToken = '', refreshToken = '', refreshed = ''

beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: `JWT ${stamp}`, slug: `jwt-${stamp}` } })
  const user = await prisma.user.create({ data: { name: 'JWT User', email: `jwt-${stamp}@test.local`, role: 'ADMIN', tenant: tenant.name, tenantId: tenant.id, passwordHash: await bcrypt.hash('Password1234', 10) } }); userId = user.id
})

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  await prisma.refreshToken.deleteMany({ where: { userId } })
  await prisma.user.deleteMany({ where: { id: userId } })
  if (user?.tenantId) await prisma.tenant.deleteMany({ where: { id: user.tenantId } })
  await prisma.$disconnect()
})

describe('JWT refresh rotation', () => {
  it('logs in, rotates refresh token, and rejects reuse of the old token', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ email: `jwt-${stamp}@test.local`, password: 'Password1234' }).expect(200)
    accessToken = login.body.accessToken; refreshToken = login.body.refreshToken
    expect(refreshToken).toBeTruthy()
    // refresh rotates: old token revoked, new token issued
    const rotated = await request(app).post('/api/v1/auth/refresh').send({ refreshToken }).expect(200)
    expect(rotated.body.accessToken).toBeTruthy(); expect(rotated.body.refreshToken).not.toBe(refreshToken)
    const oldStored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(refreshToken) } })
    expect(oldStored).toBeNull() // old token revoked
    refreshed = rotated.body.refreshToken
    // reuse of the old token is rejected
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken }).expect(401)
  })
  it('still works with the newly issued refresh token and logs out', async () => {
    const ok = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: refreshed }).expect(200)
    expect(ok.body.refreshToken).toBeTruthy()
    await request(app).post('/api/v1/auth/logout').send({ refreshToken: ok.body.refreshToken }).expect(204)
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(ok.body.refreshToken) } })
    expect(stored).toBeNull()
  })
})
