import ExcelJS from 'exceljs'
import { Readable } from 'node:stream'

export const catalogColumns = ['name', 'slug', 'sku', 'barcode', 'category', 'price', 'costPrice', 'stock', 'unit', 'packSize', 'brand', 'channel', 'active'] as const
export type CatalogColumn = typeof catalogColumns[number]

const valueOf = (value: ExcelJS.CellValue): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && 'text' in value) return String(value.text)
  if (typeof value === 'object' && 'result' in value) return String(value.result ?? '')
  return String(value)
}

export async function parseCatalogFile(buffer: Buffer, mimeType: string) {
  const workbook = new ExcelJS.Workbook()
  if (mimeType === 'text/csv' || mimeType === 'application/csv') await workbook.csv.read(Readable.from(buffer))
  else await workbook.xlsx.load(buffer as never)
  const sheet = workbook.worksheets[0]
  if (!sheet) throw Object.assign(new Error('Файл дотор worksheet олдсонгүй.'), { status: 400 })
  const header = (sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((value) => valueOf(value).trim())
  const rows: Record<string, string>[] = []
  sheet.eachRow((row, number) => {
    if (number === 1) return
    const values = (row.values as ExcelJS.CellValue[]).slice(1)
    if (values.every((value) => !valueOf(value).trim())) return
    rows.push(Object.fromEntries(header.map((key, index) => [key, valueOf(values[index] ?? '').trim()])))
  })
  return { columns: header, rows }
}

export function mapCatalogRows(rows: Record<string, string>[], mapping: Record<string, string> = {}) {
  return rows.map((source) => Object.fromEntries(catalogColumns.map((target) => [target, source[mapping[target] || target] ?? ''])))
}
