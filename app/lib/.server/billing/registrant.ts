import type { CheckoutContact } from './stripe';
import type { RegistrantContact } from '~/lib/.server/cloudflare/managed-domains-api';

/**
 * Country calling codes of one and two digits; every other one has three. No code is the start of another, so
 * the first that fits a number is its code.
 */
const ONE_DIGIT_CODES = new Set(['1', '7']);
const TWO_DIGIT_CODES = new Set(
  (
    '20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 ' +
    '90 91 92 93 94 95 98'
  ).split(' '),
);

/**
 * A phone number as a registry takes it, `+<country code>.<number>`, from the international form Stripe gives
 * (`+14155550123`). Null when it is not a number in that form.
 */
export function registryPhone(phone: string | null): string | null {
  const digits = /^\+(\d{7,15})$/.exec(phone?.replace(/[\s().-]/g, '') ?? '')?.[1];
  if (!digits) {
    return null;
  }
  const length = ONE_DIGIT_CODES.has(digits.slice(0, 1)) ? 1 : TWO_DIGIT_CODES.has(digits.slice(0, 2)) ? 2 : 3;
  return `+${digits.slice(0, length)}.${digits.slice(length)}`;
}

/**
 * The buyer as the registrant of their domain, from what they gave Stripe's page. Null when something a
 * registry needs is missing: a name, an email, a phone, or a full address.
 */
export function registrantFrom(contact: CheckoutContact): RegistrantContact | null {
  const phone = registryPhone(contact.phone);
  const address = contact.address;
  if (!contact.name || !contact.email || !phone || !address?.line1 || !address.city || !address.country) {
    return null;
  }
  return {
    email: contact.email,
    phone,
    postal_info: {
      name: contact.name,
      address: {
        street: [address.line1, address.line2].filter(Boolean).join(', '),
        city: address.city,
        // Countries without states or postal codes give none; registries take the city and a dash for them.
        state: address.state || address.city,
        postal_code: address.postalCode || '-',
        country_code: address.country,
      },
    },
  };
}
