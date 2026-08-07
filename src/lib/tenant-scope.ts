export function tenantWhere<T extends object>(tenantId: string, where?: T): T & { tenantId: string } {
  if (!tenantId) throw new Error('Tenant scope шаардлагатай.')
  return { ...(where ?? {} as T), tenantId }
}
