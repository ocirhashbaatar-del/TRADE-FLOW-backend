export type PartnerPackage = { shipmentId: string; orderNumber: string; recipient: string; phone: string; address: string; trackingCode?: string }
export interface DeliveryPartnerAdapter { code: string; handoff(packages: PartnerPackage[]): Promise<{ externalReference: string }> }
export class ManualDeliveryPartner implements DeliveryPartnerAdapter { code = 'MANUAL'; async handoff(packages: PartnerPackage[]) { return { externalReference: `MANUAL-${Date.now()}-${packages.length}` } } }
export const deliveryPartners: Record<string, DeliveryPartnerAdapter> = { MANUAL: new ManualDeliveryPartner() }
