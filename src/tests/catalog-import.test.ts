import { describe, expect, it } from 'vitest'
import { mapCatalogRows, parseCatalogFile } from '../lib/catalog-import.js'

describe('catalog file import', () => {
  it('parses UTF-8 CSV and maps columns for preview', async () => {
    const csv = Buffer.from('\uFEFFБараа,Код,Ангилал,Үнэ,Үлдэгдэл\nМонгол сүү,milk,Сүү,4500,12', 'utf8')
    const parsed = await parseCatalogFile(csv, 'text/csv')
    const [row] = mapCatalogRows(parsed.rows, { name: 'Бараа', slug: 'Код', category: 'Ангилал', price: 'Үнэ', stock: 'Үлдэгдэл' })
    expect(row).toMatchObject({ name: 'Монгол сүү', slug: 'milk', category: 'Сүү', price: '4500', stock: '12' })
  })
})
