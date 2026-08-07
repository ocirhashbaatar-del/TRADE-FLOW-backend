import { env } from '../config/env.js'

type Token = { value: string; expiresAt: number }
let cachedToken: Token | null = null

const configured = () => Boolean(env.QPAY_CLIENT_ID && env.QPAY_CLIENT_SECRET && env.QPAY_INVOICE_CODE && env.QPAY_CALLBACK_TOKEN)
export const qpayConfigured = configured

async function token() {
  if (!configured()) throw Object.assign(new Error('QPay production тохиргоо дутуу байна.'), { status: 503 })
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value
  const auth = Buffer.from(`${env.QPAY_CLIENT_ID}:${env.QPAY_CLIENT_SECRET}`).toString('base64')
  const response = await fetch(`${env.QPAY_BASE_URL}/v2/auth/token`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } })
  if (!response.ok) throw Object.assign(new Error('QPay access token авахад алдаа гарлаа.'), { status: 502 })
  const data = await response.json() as { access_token: string; expires_in?: number }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 }
  return data.access_token
}

async function request(path: string, body: unknown) {
  const accessToken = await token()
  const response = await fetch(`${env.QPAY_BASE_URL}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw Object.assign(new Error(`QPay API алдаа: ${response.status}`), { status: 502 })
  return response.json() as Promise<any>
}

export async function createQPayInvoice(input: { senderInvoiceNo: string; amount: number; description: string; callbackUrl: string }) {
  const data = await request('/v2/invoice', { invoice_code: env.QPAY_INVOICE_CODE, sender_invoice_no: input.senderInvoiceNo, invoice_receiver_code: input.senderInvoiceNo, invoice_description: input.description, amount: input.amount, callback_url: input.callbackUrl })
  return { invoiceId: String(data.invoice_id), qrText: String(data.qr_text), qrImage: data.qr_image ? String(data.qr_image) : undefined, urls: Array.isArray(data.urls) ? data.urls : [] }
}

export async function checkQPayInvoice(invoiceId: string) {
  const data = await request('/v2/payment/check', { object_type: 'INVOICE', object_id: invoiceId, offset: { page_number: 1, page_limit: 100 } })
  const rows = Array.isArray(data.rows) ? data.rows : []
  const paidAmount = rows.filter((row: any) => !['REFUNDED', 'CANCELLED', 'FAILED'].includes(String(row.payment_status ?? row.status))).reduce((sum: number, row: any) => sum + Number(row.payment_amount ?? row.amount ?? 0), 0)
  return { paid: paidAmount > 0, paidAmount, paymentId: rows[0]?.payment_id ? String(rows[0].payment_id) : undefined, raw: data }
}
