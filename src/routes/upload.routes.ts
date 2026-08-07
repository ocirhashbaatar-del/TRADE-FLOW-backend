import { Router } from 'express'
import multer from 'multer'
import sharp, { type Metadata } from 'sharp'
import { Role } from '@prisma/client'
import { authenticate, authorize } from '../middleware/auth.js'
import { cloudinary } from '../lib/services.js'
import { prisma } from '../lib/prisma.js'

const router = Router()
const minimumBytes = 100 * 1024
const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])
const allowedFormats = new Set(['jpeg', 'png', 'webp'])
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

router.post('/', authenticate, authorize(Role.ADMIN, Role.MANAGER, Role.VENDOR), upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Зураг сонгоно уу.' })
  if (!allowedMimeTypes.has(req.file.mimetype)) return res.status(400).json({ message: 'Зөвхөн JPG, JPEG, PNG эсвэл WEBP зураг оруулна уу.' })
  if (req.file.size < minimumBytes) return res.status(400).json({ message: 'Зургийн чанар хэт бага байна, өөр зураг сонгоно уу.' })

  let metadata: Metadata
  try {
    metadata = await sharp(req.file.buffer).metadata()
  } catch {
    return res.status(400).json({ message: 'Зургийн файл гэмтсэн эсвэл дэмжигдэхгүй форматтай байна.' })
  }
  if (!metadata.format || !allowedFormats.has(metadata.format)) return res.status(400).json({ message: 'Зөвхөн JPG, JPEG, PNG эсвэл WEBP зураг оруулна уу.' })
  if (!metadata.width || metadata.width < 400) return res.status(400).json({ message: 'Зургийн чанар хэт бага байна, өөр зураг сонгоно уу.' })

  const transformation: Array<Record<string, string | number>> = [
    { effect: 'improve' },
    ...(metadata.width < 800 ? [{ width: 800, crop: 'scale' }] : []),
    { quality: 'auto:best', fetch_format: 'auto' },
  ]
  const result = await new Promise<{ secure_url: string; public_id: string; bytes: number; width: number; height: number; format: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder: 'tradeflow/products', resource_type: 'image', transformation }, (error, uploaded) => {
      if (error || !uploaded) return reject(error ?? new Error('Cloudinary upload failed'))
      resolve({ secure_url: uploaded.secure_url, public_id: uploaded.public_id, bytes: uploaded.bytes, width: uploaded.width, height: uploaded.height, format: uploaded.format })
    })
    stream.end(req.file!.buffer)
  })

  try {
    const asset = await prisma.asset.create({
      data: {
        key: `product:${result.public_id}`,
        url: result.secure_url,
        publicId: result.public_id,
        mimeType: `image/${result.format === 'jpg' ? 'jpeg' : result.format}`,
        bytes: result.bytes,
        width: result.width,
        height: result.height,
      },
    })
    res.status(201).json(asset)
  } catch (error) {
    await cloudinary.uploader.destroy(result.public_id).catch(() => undefined)
    throw error
  }
})

export default router
