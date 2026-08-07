import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { Role } from '@prisma/client'
import { env } from '../config/env.js'

export type TokenPayload = { id: string; email: string; role: Role; tenantId?: string }
export const signAccessToken = (payload: TokenPayload) => jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_EXPIRES as jwt.SignOptions['expiresIn'], jwtid: crypto.randomUUID() })
export const signRefreshToken = (payload: TokenPayload) => jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: env.JWT_REFRESH_EXPIRES as jwt.SignOptions['expiresIn'], jwtid: crypto.randomUUID() })
export const verifyAccessToken = (token: string) => jwt.verify(token, env.JWT_ACCESS_SECRET) as TokenPayload & jwt.JwtPayload
export const verifyRefreshToken = (token: string) => jwt.verify(token, env.JWT_REFRESH_SECRET) as TokenPayload & jwt.JwtPayload
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex')
