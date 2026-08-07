import { PrismaClient, Role } from '@prisma/client'
import bcrypt from 'bcrypt'

// ---------------------------------------------------------------------------
// DEVELOPMENT/TEST SEED ONLY
// ---------------------------------------------------------------------------
// This seed creates a demo tenant, demo catalog and well-known user accounts
// with fixed passwords. It MUST NOT run automatically in production startup.
// Production tenants are provisioned via the platform admin or production data
// import runbook (12.7), never from this file.
//
// Guard: refuse to run when NODE_ENV=production unless SEED_PRODUCTION_ALLOWED
// is explicitly set to "true". The production deployment scripts (package.json
// `deploy:start`, Dockerfile CMD) no longer invoke the seed automatically.
const isProduction = process.env.NODE_ENV === 'production'
if (isProduction && process.env.SEED_PRODUCTION_ALLOWED !== 'true') {
  throw new Error('Demo seed нь production орчинд ажиллахыг хориглоно. SEED_PRODUCTION_ALLOWED нарийн тохиргоогоор л зөвшөөрнө.')
}

const prisma = new PrismaClient()

const catalog = [
  { name: 'Жимс', slug: 'fruit', image: '/images/category-fruit.jpg', products: ['Монгол алим', 'Ногоон алим', 'Улаан алим', 'Гадил', 'Мандарин', 'Жүрж', 'Лийр', 'Усан үзэм', 'Киви', 'Тоор', 'Чавга', 'Анар', 'Хан боргоцой', 'Тарвас', 'Амтат гуа', 'Нэрс', 'Гүзээлзгэнэ', 'Интоор', 'Манго', 'Авокадо'] },
  { name: 'Хүнсний ногоо', slug: 'vegetables', image: '/images/category-vegetables.jpg', products: ['Монгол төмс', 'Шар лууван', 'Бөөрөнхий сонгино', 'Улаан лооль', 'Өргөст хэмх', 'Амтат чинжүү', 'Байцаа', 'Цэцэгт байцаа', 'Брокколи', 'Сармис', 'Хулуу', 'Хаш', 'Бууцай', 'Салат навч', 'Ногоон сонгино', 'Яншуй', 'Хүрэн манжин', 'Цагаан манжин', 'Эрдэнэ шиш', 'Ногоон шош'] },
  { name: 'Сүү, сүүн бүтээгдэхүүн', slug: 'dairy', image: '/images/category-dairy.jpg', products: ['Цэвэр сүү 1л', 'Тослог сүү 1л', 'Лактозгүй сүү', 'Шоколадтай сүү', 'Гүзээлзгэнэтэй тараг', 'Нэрстэй тараг', 'Цэвэр тараг', 'Ундааны йогурт', 'Аарц', 'Ааруул', 'Зөөхий', 'Цөцгийн тос', 'Шар тос', 'Монгол бяслаг', 'Чеддар бяслаг', 'Моцарелла бяслаг', 'Крем бяслаг', 'Өтгөрүүлсэн сүү', 'Кефир', 'Хүүхдийн тараг'] },
  { name: 'Ус, ундаа', slug: 'drinks', image: '/images/category-drinks.jpg', products: ['Цэвэр ус 500мл', 'Цэвэр ус 1.5л', 'Газтай ус', 'Нимбэгтэй ус', 'Кола ундаа', 'Жүржийн ундаа', 'Нимбэгийн ундаа', 'Тоник ус', 'Алимны шүүс', 'Жүржийн шүүс', 'Тоорын шүүс', 'Олон жимсний шүүс', 'Улаан лоолийн шүүс', 'Ногоон цай', 'Хар цай', 'Мөстэй цай', 'Эрч хүчний ундаа', 'Изотоник ундаа', 'Кофетой ундаа', 'Комбуча'] },
  { name: 'Талх, нарийн боов', slug: 'bakery', image: '/images/category-bakery.jpg', products: ['Цагаан талх', 'Хар талх', 'Бүхэл үрийн талх', 'Хөх тарианы талх', 'Багет талх', 'Бургерийн талх', 'Хот-дог талх', 'Круассан', 'Шоколадтай круассан', 'Нэрстэй маффин', 'Шоколадтай маффин', 'Алимны пирог', 'Бяслагтай бялуу', 'Донат', 'Шанцайтай ороомог', 'Үзэмтэй боов', 'Самартай боов', 'Наполеон торт', 'Шоколадтай торт', 'Жигнэмэгийн багц'] },
  { name: 'Сав баглаа боодол', slug: 'packaging', image: '/images/category-packaging.jpg', products: ['Цаасан уут жижиг', 'Цаасан уут том', 'Даавуун тор', 'Хүнсний скоч', 'Хөнгөн цагаан фольга', 'Нэг удаагийн аяга', 'Цаасан аяга', 'Аяганы таг', 'Хоолны сав 500мл', 'Хоолны сав 750мл', 'Хоолны сав 1000мл', 'Пиццаны хайрцаг', 'Бялууны хайрцаг', 'Жимсний хайрцаг', 'Өндөгний сав', 'Вакуум уут', 'Zip уут', 'Наалддаг шошго', 'Савлагааны тууз', 'Био задардаг уут'] },
] as const

async function main() {
  const adminPasswordHash = await bcrypt.hash('Aa88016745', 12)
  const transporterPasswordHash = await bcrypt.hash('Aa88772621', 12)
  const tenant = await prisma.tenant.upsert({ where: { slug: 'tradeflow' }, update: {}, create: { name: 'TradeFlow', slug: 'tradeflow' } })
  const admin = await prisma.user.upsert({ where: { email: 'ocirhashbaatar@gmail.com' }, update: { tenantId: tenant.id, role: Role.ADMIN, platformAdmin: true }, create: { name: 'TradeFlow Admin', email: 'ocirhashbaatar@gmail.com', passwordHash: adminPasswordHash, role: Role.ADMIN, platformAdmin: true, tenant: 'TradeFlow', tenantId: tenant.id } })
  const transporter = await prisma.user.upsert({ where: { email: 'gardi@gmail.com' }, update: { tenantId: tenant.id, role: Role.TRANSPORTER }, create: { name: 'TradeFlow Тээвэрлэгч', email: 'gardi@gmail.com', passwordHash: transporterPasswordHash, role: Role.TRANSPORTER, tenant: 'TradeFlow', tenantId: tenant.id } })
  const vendor = await prisma.user.upsert({ where: { email: 'vendor@tradeflow.mn' }, update: { tenantId: tenant.id }, create: { name: 'Fresh Market', email: 'vendor@tradeflow.mn', passwordHash: adminPasswordHash, role: Role.VENDOR, tenant: 'TradeFlow', tenantId: tenant.id } })
  const categories = await Promise.all(catalog.map((category) => prisma.category.upsert({ where: { tenantId_slug: { tenantId: tenant.id, slug: category.slug } }, update: { name: category.name, image: category.image }, create: { name: category.name, slug: category.slug, image: category.image, tenantId: tenant.id } })))
  const warehouse = await prisma.warehouse.upsert({ where: { tenantId_code: { tenantId: tenant.id, code: 'MAIN' } }, update: {}, create: { tenantId: tenant.id, code: 'MAIN', name: 'Үндсэн агуулах' } })

  const products = catalog.flatMap((category, categoryIndex) => category.products.map((name, productIndex) => {
    const number = productIndex + 1
    const price = 1800 + categoryIndex * 650 + productIndex * 430
    return {
      name,
      slug: `${category.slug}-${String(number).padStart(2, '0')}`,
      description: `${name} — чанарын баталгаатай, шинэхэн бүтээгдэхүүн. Түргэн шуурхай хүргэлттэй.`,
      price,
      compareAt: number % 5 === 0 ? Math.round(price * 1.15) : undefined,
      stock: 18 + ((categoryIndex * 31 + productIndex * 17) % 180),
      image: `/images/product-${(categoryIndex * 20 + productIndex) % 8 + 1}.jpg`,
      categoryId: categories[categoryIndex]!.id,
      featured: productIndex < 2,
      rating: 4.2 + (productIndex % 8) / 10,
      reviewCount: 12 + ((categoryIndex * 23 + productIndex * 11) % 140),
      tags: [category.name, number % 3 === 0 ? 'Онцлох' : 'Шинэ'],
    }
  }))

  for (const product of products) {
    const data = { ...product, tenantId: tenant.id, sku: product.slug.toUpperCase(), images: [product.image], vendorId: vendor.id }
    const row = await prisma.product.upsert({ where: { tenantId_slug: { tenantId: tenant.id, slug: product.slug } }, update: data, create: data })
    await prisma.inventoryBalance.upsert({ where: { tenantId_warehouseId_productId_variantId: { tenantId: tenant.id, warehouseId: warehouse.id, productId: row.id, variantId: '' } }, update: { onHand: product.stock }, create: { tenantId: tenant.id, warehouseId: warehouse.id, productId: row.id, variantId: '', onHand: product.stock } })
  }
  await prisma.product.updateMany({
    where: { tenantId: tenant.id, slug: { in: ['sparkling-citrus-drink', 'crispy-potato-chips', 'fresh-fruit-box'] } },
    data: { active: false },
  })
  console.log(`Seed complete. ${products.length} products across ${catalog.length} categories. Admin: ${admin.email}; Transporter: ${transporter.email}`)
}

main().finally(async () => prisma.$disconnect())
