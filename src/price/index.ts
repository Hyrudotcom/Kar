export { compareBaskets, isEligibleSource } from './engine';
export { priceStatusOf, statusForAge, ageMs, ageDays, DAY_MS } from './status';
export { listFingerprint, fingerprintMatches } from './fingerprint';
export { unitPrice, requiredMicro, type UnitPrice } from './units';
export { costForPackages, isPromotionUsable, packagesNeeded } from './packaging';
export { isValidGtin } from './ean';
export {
  PRICE_PROVIDERS,
  providerAvailability,
  validateProviderObservation,
  type PriceProvider,
  type ProviderObservation,
  type ProviderAvailability,
} from './provider';
export { loadPriceDataset, emptyDataset, PriceDataError, type PriceReadClient } from './repository';
export * from './format';
