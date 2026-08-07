import { env } from '../config/env.js'

/**
 * Central feature-flag registry for TradeFlow.
 *
 * High-risk / external-integration modules are gated behind environment
 * variables so a release candidate can be deployed with risky flows disabled
 * during a controlled pilot (12.8) and progressively enabled.
 *
 * Flags are read once at startup from `env`. They are intentionally NOT
 * runtime-mutable; changing a flag requires a redeploy or a process restart.
 * This keeps decision logic deterministic and audit-friendly.
 *
 * See docs/ENV_MATRIX.md for owner/rotation and docs/RELEASE_CANDIDATE_CHECKLIST.md.
 */
const flag = (raw: string, defaultValue: boolean): boolean => {
  if (!raw) return defaultValue
  return raw.toLowerCase() === 'true' || raw === '1'
}

export const featureFlags = {
  /** Stripe payment provider (optional payment provider decision is outstanding). */
  stripe: flag(env.FEATURE_FLAG_STRIPE, true),
  /** Google/GitHub/Facebook OAuth identity providers. */
  oauth: flag(env.FEATURE_FLAG_OAUTH, true),
  /** QPay merchant payment / callback. */
  qpay: flag(env.FEATURE_FLAG_QPAY, true),
  /** E-barimt receipt generation (Phase-2 tax integration). */
  eBarimt: flag(env.FEATURE_FLAG_E_BARIMT, true),
  /** External delivery-partner API adapter (partner decision outstanding). */
  deliveryPartner: flag(env.FEATURE_FLAG_DELIVERY_PARTNER, false),
} as const

export type FeatureFlag = keyof typeof featureFlags

export const isEnabled = (name: FeatureFlag): boolean => featureFlags[name]

/** High-risk modules that should be disabled during a controlled pilot (12.8). */
export const highRiskPilotDefault: FeatureFlag[] = ['deliveryPartner', 'eBarimt', 'stripe']
