// Covers lib.mjs. The tools themselves are covered by the shared suites via
// their `examples`, so this tests the decisions underneath: chart lookup,
// destination resolution, and the several ways this server must refuse to
// answer rather than answer wrongly.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkLicense,
  lookupCountry,
  lookupEccn,
  normalizeEccn,
  resolveCountry,
  listCountries,
  REASON_CODES,
} from "./lib.mjs";

test("the chart data loaded and covers the published destinations", () => {
  const countries = listCountries();
  assert.ok(countries.length > 190, `only ${countries.length} destinations`);
  for (const c of ["Canada", "Japan", "Germany", "China", "Russia", "Cuba", "Iran"]) {
    assert.ok(countries.includes(c), `${c} missing from the chart`);
  }
});

test("an ECCN is recognised regardless of spacing and case", () => {
  assert.equal(normalizeEccn("3a001"), "3A001");
  assert.equal(normalizeEccn(" 3A 001 "), "3A001");
  for (const bad of ["", null, undefined, "3A01", "AA001", "3F001", "EAR99", "3A0011"]) {
    assert.equal(normalizeEccn(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

// EAR99 is the single most likely wrong input: it is what people call an item
// that is *not* on the Control List, and it is not an ECCN.
test("EAR99 is rejected as a malformed ECCN, not silently looked up", () => {
  const r = checkLicense("EAR99", "Japan");
  assert.equal(r.status, "invalid_eccn");
});

test("a controlled item to an allied destination still requires a licence", () => {
  const r = checkLicense("3A001", "Japan");
  assert.equal(r.status, "ok");
  assert.equal(r.licenseRequired, true);
  const reasons = r.triggeredBy.map((t) => t.column);
  assert.ok(reasons.includes("NS1"), `expected NS1, got ${reasons.join(",")}`);
  // The scope caveat is the point: most controls cover part of an entry only.
  assert.ok(r.triggeredBy.every((t) => typeof t.scope === "string" && t.scope.length));
});

test("Canada carries only CB1 and FC1, so most entries clear the chart", () => {
  const c = lookupCountry("Canada");
  assert.equal(c.status, "ok");
  assert.deepEqual(c.columns.map((x) => x.column).sort(), ["CB1", "FC1"]);
  const r = checkLicense("3A001", "Canada");
  assert.equal(r.licenseRequired, false);
});

test("a chart answer always says what it does not cover", () => {
  for (const r of [checkLicense("3A001", "Japan"), checkLicense("3A001", "Canada")]) {
    assert.ok(r.notCovered.length >= 4);
    assert.ok(r.notCovered.some((n) => /Entity List/i.test(n)), "must name end-user controls");
    assert.ok(r.notCovered.some((n) => /classification|exporter/i.test(n)), "must disclaim classification");
  }
});

// Reading a blank chart row for an embargoed destination as "no licence needed"
// is the worst error this data can produce, so these never reach the grid.
test("embargoed destinations refuse to answer and refer onward", () => {
  for (const c of ["Cuba", "Iran", "Korea, North", "Syria"]) {
    const r = checkLicense("0A501", c);
    assert.equal(r.status, "embargoed", `${c} was not treated as embargoed`);
    assert.equal(r.licenseRequired, undefined, `${c} returned a chart verdict`);
    assert.match(r.referral, /74[0-9]/, `${c} has no part referral`);
  }
});

test("an ambiguous destination returns the options instead of choosing", () => {
  const r = checkLicense("3A001", "Congo");
  assert.equal(r.status, "ambiguous_country");
  assert.ok(r.candidates.length > 1);
  assert.equal(r.licenseRequired, undefined, "must not answer on a guess");
});

test("common country spellings resolve to the chart's own naming", () => {
  assert.equal(resolveCountry("South Korea").match, "Korea, South");
  assert.equal(resolveCountry("UK").match, "United Kingdom");
  assert.equal(resolveCountry("russian federation").match, "Russia");
});

// The chart lists destinations, so the US is legitimately absent. Reporting
// that as "unknown country" reads as a data gap and invites a pointless retry.
test("the United States is answered as not-a-destination, not as unknown", () => {
  for (const q of ["USA", "United States", "us", "America"]) {
    assert.equal(lookupCountry(q).status, "not_a_destination", `${q} was misreported`);
  }
  const r = checkLicense("3A001", "USA");
  assert.equal(r.status, "not_a_destination");
  assert.equal(r.licenseRequired, undefined);
  assert.match(r.message, /deemed export/i, "must point at the deemed-export rule");
});

test("an unknown destination is not resolved to a near miss", () => {
  const r = lookupCountry("Wakanda");
  assert.notEqual(r.status, "ok");
});

test("an unknown ECCN is never reported as needing no licence", () => {
  const r = checkLicense("0A997", "Japan");   // well-formed, absent from the CCL
  assert.equal(r.status, "unknown_eccn");
  assert.equal(r.licenseRequired, undefined);
  assert.match(r.message, /not.*no licence required|Do not read/i);
});

test("entries the chart does not decide are kept and flagged", () => {
  // 0A002 is subject to the ITAR; it has no country-chart table. Dropping such
  // entries would make a real, controlled ECCN answer "unknown".
  const r = lookupEccn("0A002");
  assert.equal(r.status, "ok");
  assert.equal(r.chartDetermined, false);
});

test("controls the chart does not decide are surfaced, not swallowed", () => {
  const r = checkLicense("5A002", "Canada");
  assert.equal(r.status, "ok");
  assert.ok(r.controlsNotOnChart.length > 0, "5A002 has non-chart RS and EI controls");
  assert.ok(r.controlsNotOnChart.every((c) => c.requirement.length > 0));
});

test("every reason code on a looked-up entry expands to a name", () => {
  const r = lookupEccn("5A002");
  assert.equal(r.status, "ok");
  for (const { code, name } of r.reasons) {
    assert.ok(REASON_CODES[code], `unknown reason code ${code}`);
    assert.equal(name, REASON_CODES[code]);
  }
});
