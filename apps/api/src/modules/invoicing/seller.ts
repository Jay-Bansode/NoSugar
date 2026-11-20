import type { Env } from '../../config/env.js';

/** The seller as printed on invoices. GSTIN and state code are also stored as columns. */
export interface Seller {
  legalName: string;
  address: string;
  gstin: string;
  stateCode: string;
  fssaiLicenceNo: string;
  /** True outside production: PDFs are stamped as specimens, not valid tax invoices. */
  specimen: boolean;
}

/**
 * PLACEHOLDERS for development and tests only; production refuses to start without the real
 * values (config/env.ts). docs/pending-decisions.md #12.
 */
const PLACEHOLDER = {
  legalName: 'Brand Foods Private Limited (PLACEHOLDER)',
  address: 'PLACEHOLDER address, Pune, Maharashtra 411001',
  gstin: '27ABCDE1234F1Z5',
  stateCode: '27',
  fssaiLicenceNo: '00000000000000',
} as const;

export function sellerFromEnv(env: Env): Seller {
  return {
    legalName: env.SELLER_LEGAL_NAME ?? PLACEHOLDER.legalName,
    address: env.SELLER_ADDRESS ?? PLACEHOLDER.address,
    gstin: env.SELLER_GSTIN ?? PLACEHOLDER.gstin,
    stateCode: env.SELLER_STATE_CODE ?? env.SELLER_GSTIN?.slice(0, 2) ?? PLACEHOLDER.stateCode,
    fssaiLicenceNo: env.FSSAI_LICENSE_NO ?? PLACEHOLDER.fssaiLicenceNo,
    specimen: env.NODE_ENV !== 'production',
  };
}
