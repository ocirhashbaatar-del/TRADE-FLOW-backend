import { Router } from 'express'
import multer from 'multer'
import sharp, { type Metadata } from 'sharp'
import { Role } from '@prisma/client'
import { authenticate, authorize } from '../middleware/auth.js'
import { cloudinary } from '../lib/services.js'
import { prisma } from '../lib/prisma.js'

const router = Router()
const maximumBytes = 5 * 1024 * 1024
const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp'])
const allowedFormats = new Set(['jpeg', 'png', 'webp'])
// Defense against MIME spoofing: treat the declared Content-Type as advisory and
// reject any type that is not an image. Combined with `sharp().metadata()` the
// file content must actually decode as an allowed raster before storage.
const opaqueTypes = new Set(['application/octet-stream', 'application/x-www-form-urlencoded', 'text/plain'])
const dangerousExtension = /\.(?:exe|bat|cmd|com|dll|sh|bash|zsh|php|php[0-9]|phtml|pht|jsp|asp|aspx|jar|js|mjs|py|rb|pl|ps1|vbs|hta|msi|svg|html?|shtml|swf|apk|deb|rpm)(?:$|\.)/i
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maximumBytes } })

function sanitizeFilename(original: string | undefined): string {
  if (!original) return 'image'
  // Strip any path separators / traversal sequences and keep only a safe basename.
  const base = original.split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 120)
  return clean || 'image'
}

router.post('/', authenticate, authorize(Role.ADMIN, Role.MANAGER, Role.VENDOR), upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Upload request-д зургийн файл ирсэнгүй. Зургаа дахин сонгоно уу.' })
  const safeName = sanitizeFilename(req.file.originalname)
  if (dangerousExtension.test(safeName.toLowerCase())) return res.status(400).json({ message: 'Энэ файлын нэр зөвшөөрөгдөхгүй байна.' })
  if (req.file.size > maximumBytes || req.file.size === 0) return res.status(400).json({ message: 'Зургийн файл хоосон эсвэл 5MB-аас том байна.' })
  if (opaqueTypes.has(req.file.mimetype) || !allowedMimeTypes.has(req.file.mimetype)) return res.status(400).json({ message: 'Зөвхөн JPG, JPEG, PNG эсвэл WEBP зураг оруулна уу.' })
  let metadata: Metadata
  try {
    metadata = await sharp(req.file.buffer).metadata()
  } catch {
    return res.status(400).json({ message: 'Зургийн файл гэмтсэн эсвэл дэмжигдэхгүй форматтай байна.' })
  }
  if (!metadata.format || !allowedFormats.has(metadata.format)) return res.status(400).json({ message: 'Зөвхөн JPG, JPEG, PNG эсвэл WEBP зураг оруулна уу.' })
  if (!metadata.width || !metadata.height) return res.status(400).json({ message: 'Зургийн өргөн, өндөр тодорхойгүй байна.' })

  const transformation: Array<Record<string, string | number>> = [
    { effect: 'improve' },
    ...(metadata.width < 1200 ? [{ width: 1200, crop: 'scale' }] : []),
    { dpr: 'auto' },
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
