import { Redis } from 'ioredis'
import { env } from '../config/env.js'

export const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
redis.on('error', (error: Error) => console.warn('Redis unavailable:', error.message))
export async function connectRedis() { if (redis.status === 'wait') await redis.connect().catch(() => undefined) }
export async function cacheGet<T>(key: string): Promise<T | null> { if (redis.status !== 'ready') return null; const value = await redis.get(key); return value ? JSON.parse(value) as T : null }
export async function cacheSet(key: string, value: unknown, ttl = 60) { if (redis.status === 'ready') await redis.set(key, JSON.stringify(value), 'EX', ttl) }
export async function cacheDelete(pattern: string) { if (redis.status !== 'ready') return; const keys = await redis.keys(pattern); if (keys.length) await redis.del(...keys) }
