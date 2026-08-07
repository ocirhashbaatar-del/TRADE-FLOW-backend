import type { Prisma } from '@prisma/client'
import { assertPeriodOpen } from './period-lock.js'

export async function postPayment(tx: Prisma.TransactionClient, input: { tenantId: string; customerId: string; amount: number; method: 'QPAY' | 'BANK' | 'CASH' | 'STRIPE'; reference: string; recordedBy?: string; paidAt?: Date }) {
  await assertPeriodOpen(tx, input.tenantId, input.paidAt ?? new Date())
  const duplicate = await tx.paymentRecord.findUnique({ where: { tenantId_reference: { tenantId: input.tenantId, reference: input.reference } } })
  if (duplicate) return { payment: duplicate, allocated: 0, unallocated: 0, idempotent: true }
  const payment = await tx.paymentRecord.create({ data: { tenantId: input.tenantId, customerId: input.customerId, amount: input.amount, method: input.method, reference: input.reference, recordedBy: input.recordedBy, paidAt: input.paidAt } })
  const invoices = await tx.invoice.findMany({ where: { tenantId: input.tenantId, status: { in: ['OPEN', 'PARTIAL', 'PARTIALLY_CREDITED'] } }, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }] })
  let remaining = input.amount
  for (const invoice of invoices) {
    if (remaining <= 0) break
    const [paid, credited] = await Promise.all([tx.paymentAllocation.aggregate({ where: { tenantId: input.tenantId, invoiceId: invoice.id }, _sum: { amount: true } }), tx.creditNote.aggregate({ where: { tenantId: input.tenantId, invoiceId: invoice.id, status: 'ISSUED' }, _sum: { total: true } })])
    const due = Math.max(0, Number(invoice.total) - Number(paid._sum.amount ?? 0) - Number(credited._sum.total ?? 0)), amount = Math.min(due, remaining)
    if (amount <= 0) continue
    await tx.paymentAllocation.create({ data: { tenantId: input.tenantId, paymentId: payment.id, invoiceId: invoice.id, amount } })
    await tx.invoice.update({ where: { id: invoice.id }, data: { status: amount >= due ? 'PAID' : 'PARTIAL' } })
    remaining -= amount
  }
  const period = payment.paidAt.toISOString().slice(0, 7), allocated = input.amount - remaining
  await tx.financialEntry.createMany({ data: [{ tenantId: input.tenantId, account: input.method === 'CASH' ? 'CASH' : 'BANK', reference: input.reference, debit: input.amount, period, createdBy: input.recordedBy }, { tenantId: input.tenantId, account: 'ACCOUNTS_RECEIVABLE', reference: input.reference, credit: allocated, period, createdBy: input.recordedBy }] })
  return { payment, allocated, unallocated: remaining, idempotent: false }
}
