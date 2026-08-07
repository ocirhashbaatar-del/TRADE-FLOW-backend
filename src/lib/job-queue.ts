import { PgBoss } from 'pg-boss'
import { env } from '../config/env.js'
import { createExpiryAlerts } from './expiry-worker.js'
import { reconcileInventory, releaseExpiredReservations } from './inventory.js'
import { prisma } from './prisma.js'
import { sendMail } from './services.js'

const queues = {
  reservations: 'maintenance.release-reservations',
  expiry: 'maintenance.expiry-alerts',
  reconcile: 'maintenance.inventory-reconcile',
  reminders: 'maintenance.invoice-reminders',
  dead: 'maintenance.dead-letter',
} as const

let boss: PgBoss | null = null

async function sendOverdueReminders() {
  const invoices = await prisma.invoice.findMany({ where: { status: { in: ['OPEN', 'PARTIAL'], }, dueDate: { lt: new Date() } } })
  for (const invoice of invoices) {
    const order = await prisma.order.findFirst({ where: { id: invoice.orderId, tenantId: invoice.tenantId }, include: { user: true } })
    if (order && !order.user.email.includes('@guest.tradeflow.local')) await sendMail(order.user.email, `${invoice.code} төлбөрийн сануулга`, `<p>${invoice.code} нэхэмжлэлийн төлбөрийн хугацаа дууссан байна.</p>`)
  }
  return invoices.length
}

export async function startJobQueue() {
  boss = new PgBoss({ connectionString: env.DATABASE_URL, application_name: 'tradeflow-worker' })
  boss.on('error', (error) => console.error(JSON.stringify({ level: 'error', type: 'queue', message: error.message })))
  await boss.start()
  await boss.createQueue(queues.dead)
  for (const name of [queues.reservations, queues.expiry, queues.reconcile, queues.reminders]) await boss.createQueue(name, { retryLimit: 5, retryDelay: 30, retryBackoff: true, deadLetter: queues.dead })
  await boss.work(queues.reservations, async () => releaseExpiredReservations())
  await boss.work(queues.expiry, async () => createExpiryAlerts())
  await boss.work(queues.reconcile, async () => reconcileInventory())
  await boss.work(queues.reminders, async () => sendOverdueReminders())
  await boss.schedule(queues.reservations, '* * * * *', {}, { tz: 'Asia/Ulaanbaatar' })
  await boss.schedule(queues.expiry, '0 * * * *', {}, { tz: 'Asia/Ulaanbaatar' })
  await boss.schedule(queues.reconcile, '15 2 * * *', {}, { tz: 'Asia/Ulaanbaatar' })
  await boss.schedule(queues.reminders, '0 9 * * *', {}, { tz: 'Asia/Ulaanbaatar' })
  return boss
}

export async function stopJobQueue() { await boss?.stop({ graceful: true }); boss = null }
export async function jobQueueHealth() { return boss ? { running: true, queues: await boss.getQueues(Object.values(queues)) } : { running: false, queues: [] } }
