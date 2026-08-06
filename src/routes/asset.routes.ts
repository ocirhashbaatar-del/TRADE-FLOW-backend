import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { cacheGet, cacheSet } from '../lib/redis.js'

const router = Router()
router.get('/', async (_req, res) => {
  const cached = await cacheGet<Record<string, string>>('assets:manifest')
  if (cached) return res.json(cached)
  const assets = await prisma.asset.findMany({ select: { key: true, url: true } })
  const manifest = Object.fromEntries(assets.map((asset) => [asset.key, asset.url]))
  await cacheSet('assets:manifest', manifest, 3600)
  res.json(manifest)
})
router.get('/:key', async (req, res) => {
  const key = String(req.params.key)
  const cached = await cacheGet<string>(`asset:${key}`)
  if (cached) return res.redirect(302, cached)
  const asset = await prisma.asset.findUnique({ where: { key } })
  if (!asset) return res.status(404).json({ message: 'Зураг олдсонгүй.' })
  await cacheSet(`asset:${key}`, asset.url, 3600)
  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400')
  res.redirect(302, asset.url)
})
export default router
