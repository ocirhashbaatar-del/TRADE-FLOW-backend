import { AsyncLocalStorage } from 'node:async_hooks'

type TenantContext = { tenantId?: string }
export const tenantContext = new AsyncLocalStorage<TenantContext>()

export function setTenantContext(tenantId?: string) {
  if (tenantId) tenantContext.enterWith({ ...(tenantContext.getStore() ?? {}), tenantId })
}
