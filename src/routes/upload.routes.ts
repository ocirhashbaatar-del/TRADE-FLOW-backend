import { Router } from 'express'
import multer from 'multer'
import { Role } from '@prisma/client'
import { authenticate, authorize } from '../middleware/auth.js'
import { cloudinary } from '../lib/services.js'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (_req, file, callback) => callback(null, file.mimetype.startsWith('image/')) })
router.post('/', authenticate, authorize(Role.ADMIN, Role.MANAGER, Role.VENDOR), upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Зураг сонгоно уу.' })
  const result = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => { const stream = cloudinary.uploader.upload_stream({ folder: 'tradeflow/products' }, (error, uploaded) => error || !uploaded ? reject(error) : resolve(uploaded)); stream.end(req.file!.buffer) })
  res.status(201).json({ url: result.secure_url, publicId: result.public_id })
})
export default router
