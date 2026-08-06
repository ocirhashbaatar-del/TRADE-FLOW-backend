import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { v2 as cloudinary } from 'cloudinary'
import { PrismaClient } from '@prisma/client'
import 'dotenv/config'

const prisma = new PrismaClient()
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.resolve(root, process.env.ASSET_SOURCE_DIR ?? '../Supply/public/images')
const mimeTypes: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' }

cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET })

async function main() {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) throw new Error('Cloudinary environment variables are required.')
  const files = (await fs.readdir(source, { withFileTypes: true })).filter((entry) => entry.isFile() && mimeTypes[path.extname(entry.name).toLowerCase()])
  for (const file of files) {
    const filePath = path.join(source, file.name)
    const stat = await fs.stat(filePath)
    const result = await cloudinary.uploader.upload(filePath, { public_id: path.parse(file.name).name, folder: 'tradeflow/assets', overwrite: true, resource_type: 'image' })
    await prisma.asset.upsert({ where: { key: file.name }, update: { url: result.secure_url, publicId: result.public_id, mimeType: mimeTypes[path.extname(file.name).toLowerCase()]!, bytes: result.bytes ?? stat.size, width: result.width, height: result.height }, create: { key: file.name, url: result.secure_url, publicId: result.public_id, mimeType: mimeTypes[path.extname(file.name).toLowerCase()]!, bytes: result.bytes ?? stat.size, width: result.width, height: result.height } })
    await prisma.product.updateMany({ where: { image: `/images/${file.name}` }, data: { image: result.secure_url, images: [result.secure_url] } })
    console.log(`✓ ${file.name}`)
  }
  console.log(`${files.length} assets synced to Cloudinary and PostgreSQL.`)
}

main().finally(() => prisma.$disconnect())
