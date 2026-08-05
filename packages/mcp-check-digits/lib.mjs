// Check-digit algorithms for common high-stakes identifiers.
//
// These are the cases where a language model guessing costs real money: a
// transposed IBAN digit routes a payment nowhere, a bad NPI rejects a claim, a
// wrong VIN check digit fails a title transfer. All pure arithmetic, no data
// files, no network.

const clean = (s) => String(s ?? "").replace(/[\s-]/g, "").toUpperCase();

// ---------------------------------------------------------------- Luhn (mod 10)

export function luhn(digits) {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function luhnCheckDigit(partial) {
  if (!/^\d+$/.test(partial)) throw new Error("expected digits only");
  for (let c = 0; c < 10; c++) if (luhn(partial + c)) return String(c);
  throw new Error("unreachable");
}

// --------------------------------------------------------------- mod-97 (ISO 7064)

// Big-integer mod 97 without BigInt allocation, for IBAN and LEI.
function mod97(numeric) {
  let remainder = 0;
  for (const ch of numeric) {
    remainder = (remainder * 10 + (ch.charCodeAt(0) - 48)) % 97;
  }
  return remainder;
}

const lettersToDigits = (s) =>
  s.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));

// ------------------------------------------------------------------------ IBAN

// Official registry lengths. An IBAN of the wrong length for its country is
// invalid even when the checksum happens to pass.
const IBAN_LENGTHS = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
  IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20,
  LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30,
  NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22,
  SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28,
  TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

export function validateIban(input) {
  const s = clean(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) {
    return { valid: false, code: "format", reason: "must start with 2 letters then 2 digits" };
  }
  const country = s.slice(0, 2);
  const expected = IBAN_LENGTHS[country];
  if (expected === undefined) {
    return { valid: false, code: "unknown_country", reason: `unknown IBAN country code "${country}"` };
  }
  if (s.length !== expected) {
    return {
      valid: false,
      code: "length",
      reason: `${country} IBANs are ${expected} characters, got ${s.length}`,
    };
  }
  const rearranged = lettersToDigits(s.slice(4) + s.slice(0, 4));
  const ok = mod97(rearranged) === 1;
  return {
    valid: ok,
    country,
    length: s.length,
    normalized: s,
    ...(ok ? {} : { code: "checksum", reason: "mod-97 checksum failed" }),
  };
}

// ------------------------------------------------------------------------- LEI

export function validateLei(input) {
  const s = clean(input);
  if (!/^[A-Z0-9]{18}\d{2}$/.test(s)) {
    return { valid: false, code: "format", reason: "LEI is 20 alphanumerics ending in 2 digits" };
  }
  const ok = mod97(lettersToDigits(s)) === 1;
  return { valid: ok, normalized: s, ...(ok ? {} : { code: "checksum", reason: "mod-97 checksum failed" }) };
}

// ------------------------------------------------------------------- ISBN / EAN

export function validateIsbn10(input) {
  const s = clean(input);
  if (!/^\d{9}[\dX]$/.test(s)) return { valid: false, code: "format", reason: "ISBN-10 is 9 digits plus check (0-9 or X)" };
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = s[i];
    sum += (10 - i) * (ch === "X" ? 10 : ch.charCodeAt(0) - 48);
  }
  const ok = sum % 11 === 0;
  return { valid: ok, normalized: s, ...(ok ? {} : { code: "checksum", reason: "mod-11 checksum failed" }) };
}

function gtinValid(s, startWeight) {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const w = i % 2 === 0 ? startWeight : startWeight === 1 ? 3 : 1;
    sum += w * (s.charCodeAt(i) - 48);
  }
  return sum % 10 === 0;
}

export function validateIsbn13(input) {
  const s = clean(input);
  if (!/^\d{13}$/.test(s)) return { valid: false, code: "format", reason: "ISBN-13 is 13 digits" };
  if (!/^97[89]/.test(s)) return { valid: false, code: "format", reason: "ISBN-13 must start 978 or 979" };
  const ok = gtinValid(s, 1);
  return { valid: ok, normalized: s, ...(ok ? {} : { code: "checksum", reason: "GTIN checksum failed" }) };
}

export function validateGtin(input) {
  const s = clean(input);
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(s)) {
    return { valid: false, code: "format", reason: "GTIN must be 8, 12, 13 or 14 digits" };
  }
  // For even-length GTINs the check digit sits in an even position, which flips
  // which weight the string starts on.
  const startWeight = s.length % 2 === 0 ? 3 : 1;
  const ok = gtinValid(s, startWeight);
  // Named `width`, not `kind`. identify() builds each match as { kind, ...r },
  // so a field called `kind` here would overwrite the format key and report
  // "EAN-13" where every other format reports its VALIDATORS name. That value
  // is not accepted by validate_identifier's `kind` enum, so the two tools
  // would not compose.
  const width = { 8: "EAN-8", 12: "UPC-A", 13: "EAN-13", 14: "GTIN-14" }[s.length];
  return { valid: ok, width, normalized: s, ...(ok ? {} : { code: "checksum", reason: "GTIN checksum failed" }) };
}

// ------------------------------------------------------------------------- VIN

const VIN_TRANSLIT = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export function validateVin(input) {
  const s = clean(input);
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(s)) {
    return { valid: false, code: "format", reason: "VIN is 17 chars, excluding I, O and Q" };
  }
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = s[i];
    const v = ch >= "0" && ch <= "9" ? ch.charCodeAt(0) - 48 : VIN_TRANSLIT[ch];
    sum += v * VIN_WEIGHTS[i];
  }
  const rem = sum % 11;
  const expected = rem === 10 ? "X" : String(rem);
  const ok = s[8] === expected;
  return {
    valid: ok,
    normalized: s,
    expectedCheckDigit: expected,
    actualCheckDigit: s[8],
    ...(ok ? {} : { code: "checksum", reason: `check digit at position 9 should be ${expected}` }),
  };
}

// ------------------------------------------------------------------------- NPI

export function validateNpi(input) {
  const s = clean(input);
  if (!/^\d{10}$/.test(s)) return { valid: false, code: "format", reason: "NPI is 10 digits" };
  // NPI prefixes the NPPES issuer id before the Luhn check.
  const ok = luhn("80840" + s);
  return { valid: ok, normalized: s, ...(ok ? {} : { code: "checksum", reason: "Luhn checksum failed" }) };
}

// ------------------------------------------------------------------------ ISIN

export function validateIsin(input) {
  const s = clean(input);
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(s)) {
    return { valid: false, code: "format", reason: "ISIN is 2 letters, 9 alphanumerics, 1 check digit" };
  }
  const ok = luhn(lettersToDigits(s));
  return { valid: ok, country: s.slice(0, 2), normalized: s, ...(ok ? {} : { code: "checksum", reason: "Luhn checksum failed" }) };
}

// ---------------------------------------------------------------- ABA routing

export function validateAba(input) {
  const s = clean(input);
  if (!/^\d{9}$/.test(s)) return { valid: false, code: "format", reason: "ABA routing number is 9 digits" };
  const d = [...s].map((c) => c.charCodeAt(0) - 48);
  const sum =
    3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + 1 * (d[2] + d[5] + d[8]);
  const ok = sum % 10 === 0;
  return { valid: ok, normalized: s, ...(ok ? {} : { code: "checksum", reason: "ABA weighted checksum failed" }) };
}

// -------------------------------------------------------------- credit cards

const CARD_BRANDS = [
  { brand: "Visa", re: /^4\d{12}(\d{3})?(\d{3})?$/ },
  { brand: "Mastercard", re: /^(5[1-5]\d{14}|2(2[2-9]\d{12}|[3-6]\d{13}|7[01]\d{12}|720\d{12}))$/ },
  { brand: "American Express", re: /^3[47]\d{13}$/ },
  { brand: "Discover", re: /^(6011\d{12}|65\d{14}|64[4-9]\d{13})$/ },
  { brand: "JCB", re: /^35(2[89]|[3-8]\d)\d{12}$/ },
  { brand: "Diners Club", re: /^3(0[0-5]|[68]\d)\d{11}$/ },
  { brand: "UnionPay", re: /^62\d{14,17}$/ },
];

export function validateCard(input) {
  const s = clean(input);
  if (!/^\d{12,19}$/.test(s)) return { valid: false, code: "format", reason: "card numbers are 12-19 digits" };
  const ok = luhn(s);
  const match = CARD_BRANDS.find((b) => b.re.test(s));
  return {
    valid: ok,
    brand: match?.brand ?? "unknown",
    length: s.length,
    ...(ok ? {} : { code: "checksum", reason: "Luhn checksum failed" }),
  };
}

// ------------------------------------------------------------------ dispatch

export const VALIDATORS = {
  iban: validateIban,
  lei: validateLei,
  isbn10: validateIsbn10,
  isbn13: validateIsbn13,
  gtin: validateGtin,
  vin: validateVin,
  npi: validateNpi,
  isin: validateIsin,
  aba: validateAba,
  card: validateCard,
};

/** Try every validator and report which formats the input satisfies. */
export function identify(input) {
  const matches = [];
  for (const [kind, fn] of Object.entries(VALIDATORS)) {
    let r;
    try {
      r = fn(input);
    } catch {
      continue;
    }
    if (r.valid) matches.push({ kind, ...r });
  }
  return { input: clean(input), matches, matched: matches.length > 0 };
}
