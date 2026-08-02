// Known-good and known-bad vectors. The entire value proposition of this server
// is that it is right when a model guessing would be wrong, so every algorithm
// gets a real published identifier rather than a synthetic one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { VALIDATORS, identify, luhnCheckDigit } from "./lib.mjs";

const VALID = {
  iban: ["GB82 WEST 1234 5698 7654 32", "DE89370400440532013000", "FR1420041010050500013M02606"],
  // Real published LEIs: Apple, Microsoft, HSBC Holdings.
  lei: ["HWUPKR0MPOU8FGXBT394", "INR2EJN1ERAN0W5ZP974", "MLU0ZO3ML4LN2LL2TL39"],
  isbn10: ["0306406152", "0-19-852663-6"],
  isbn13: ["9780306406157", "978-0-306-40615-7"],
  gtin: ["036000291452", "9780306406157", "12345670"],
  vin: ["1HGCM82633A004352", "1M8GDM9AXKP042788"],
  npi: ["1234567893"],
  isin: ["US0378331005", "GB0002634946"],
  aba: ["021000021", "011000015"],
  card: ["4532015112830366", "371449635398431", "5425233430109903"],
};

// Single transposition or digit change from a valid value.
const INVALID = {
  iban: ["GB82 WEST 1234 5698 7654 33", "DE89370400440532013001", "ZZ89370400440532013000"],
  lei: ["HWUPKR0MPOU8FGXBT395", "INR2EJN1ERAN0W5ZP975"],
  isbn10: ["0306406153"],
  isbn13: ["9780306406158", "1230306406157"],
  gtin: ["036000291453"],
  vin: ["1HGCM82634A004352", "1HGCM8263IA004352"],
  npi: ["1234567890"],
  isin: ["US0378331006"],
  aba: ["021000022"],
  card: ["4532015112830367"],
};

for (const [kind, samples] of Object.entries(VALID)) {
  test(`${kind}: accepts known-good identifiers`, () => {
    for (const s of samples) {
      const r = VALIDATORS[kind](s);
      assert.equal(r.valid, true, `${kind} rejected ${s}: ${r.reason ?? "no reason given"}`);
    }
  });
}

for (const [kind, samples] of Object.entries(INVALID)) {
  test(`${kind}: rejects corrupted identifiers`, () => {
    for (const s of samples) {
      const r = VALIDATORS[kind](s);
      assert.equal(r.valid, false, `${kind} wrongly accepted ${s}`);
      assert.ok(r.reason, `${kind} rejected ${s} without explaining why`);
    }
  });
}

test("luhn check digit round-trips", () => {
  assert.equal(luhnCheckDigit("453201511283036"), "6");
  assert.equal(VALIDATORS.card("453201511283036" + luhnCheckDigit("453201511283036")).valid, true);
});

test("identify finds the right format", () => {
  const r = identify("US0378331005");
  assert.equal(r.matched, true);
  assert.ok(r.matches.some((m) => m.kind === "isin"), "expected ISIN among matches");
});

test("garbage matches nothing", () => {
  assert.equal(identify("hello world").matched, false);
});
