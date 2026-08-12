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
  SOURCE_EDITION,
} from "./lib.mjs";
import { COUNTRIES, ECCNS } from "./data.mjs";

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
  assert.equal(r.status, "indeterminate");
  assert.equal(r.chartDetermined, false);
  assert.ok(r.title.length, "the heading is the useful part of an unanswerable entry");
});

// The whole point of the guard. 0A983 reads "a license is required for ALL
// destinations", so an entry the chart does not decide is the opposite of an
// entry with no requirement.
test("an entry the chart does not decide refuses to answer instead of clearing it", () => {
  for (const eccn of ["0A983", "0A981", "1C355", "5D980", "0A002", "9A103"]) {
    const r = checkLicense(eccn, "France");
    assert.equal(r.status, "indeterminate", `${eccn} was given a chart verdict`);
    assert.equal(r.licenseRequired, undefined, `${eccn} was answered without a chart control`);
  }
});

// The requirement is the whole value of an entry the chart cannot answer. It
// was dropped entirely by the first generator, which is what made these entries
// look uncontrolled.
test("an off-chart control returns the requirement text verbatim", () => {
  const r = checkLicense("0A983", "France");
  assert.equal(r.controlsNotOnChart.length, 1);
  assert.match(r.controlsNotOnChart[0].requirement, /license is required for ALL destinations/i);
  assert.match(r.message, /verbatim|not a finding|before treating anything as cleared/i);
});

test("a control the chart does decide is still answered normally", () => {
  // 6D201's two rows carry a trailing empty cell, and dropping them for that
  // lost an NP control on software for high-speed imaging.
  const r = checkLicense("6D201", "Pakistan");
  assert.equal(r.status, "ok");
  assert.equal(r.licenseRequired, true);
  assert.ok(r.triggeredBy.some((t) => t.column === "NP1"), "NP1 must trigger for Pakistan");
});

// The invariant, over the whole list rather than a hand-picked entry. A verdict
// has to be backed by a control that was actually read. An entry whose controls
// are empty says nothing about licensing, and "nothing" must not be rendered as
// `false`, which is how 72 entries cleared every destination before this.
//
// Note what this does *not* require: that a false verdict names a control. An
// entry controlled only for RS1 and AT1 legitimately clears Canada, which marks
// neither, and reports nothing triggered. The distinction is between a control
// that was read and did not fire, and a control that was never there.
test("no destination gets a verdict from an entry with no controls", () => {
  const sample = ["Canada", "Japan", "Germany", "China", "Russia", "Brazil", "India"];
  let answered = 0;
  for (const eccn of Object.keys(ECCNS)) {
    for (const country of sample) {
      const r = checkLicense(eccn, country);
      if (r.status !== "ok") continue;
      answered++;
      assert.ok(ECCNS[eccn].c.length, `${eccn} to ${country} was answered from an empty control list`);
      assert.equal(typeof r.licenseRequired, "boolean");
    }
  }
  assert.ok(answered > 3000, `only ${answered} lookups were answered at all`);
});

test("controls the chart does not decide are surfaced, not swallowed", () => {
  const r = checkLicense("5A002", "Canada");
  assert.equal(r.status, "ok");
  assert.ok(r.controlsNotOnChart.length > 0, "5A002 has non-chart RS and EI controls");
  assert.ok(r.controlsNotOnChart.every((c) => c.requirement.length > 0));
});

// Over every entry, not one clean example. Checking only 5A002 is why 20
// entries shipped with the paragraphs following the reason line parsed as
// reason codes: 5E002 carried 341 of them, 329 expanding to null.
test("every reason code on every entry expands to a name", () => {
  for (const eccn of Object.keys(ECCNS)) {
    const r = lookupEccn(eccn);
    for (const { code, name } of r.reasons ?? []) {
      assert.ok(REASON_CODES[code], `${eccn}: "${code}" is not a reason-for-control code`);
      assert.equal(name, REASON_CODES[code]);
    }
    assert.ok(r.reasons.length < 8, `${eccn} has ${r.reasons.length} reasons, which is prose, not codes`);
  }
});

// Both bugs are invisible in any single lookup: a truncated string still reads
// as a sentence, and an undecoded entity still reads as a name. Türkiye was
// stored as "T&#xFC;rkiye" and could not be found by any spelling at all.
test("no stored string is truncated or carries an undecoded entity", () => {
  const strings = [
    ...Object.keys(COUNTRIES),
    ...Object.values(ECCNS).flatMap((e) => [e.t, ...e.c.flatMap((c) => [c[0], c[1]])]),
  ];
  for (const s of strings) {
    assert.doesNotMatch(s, /&[a-z]+;|&#x?[0-9a-f]+;/i, `undecoded entity: ${s.slice(0, 60)}`);
  }
  // A cap is invisible string by string, since a cut sentence still reads as a
  // sentence. It is visible in the longest one: the previous generator capped
  // at 220 and put 153 titles and 70 control strings exactly on it, so nothing
  // in the data could be longer. The Control List has headings well past that,
  // and a scope caveat is the operative text of a control, so losing its tail
  // changes what the entry says.
  const longest = Math.max(...strings.map((s) => s.length));
  assert.ok(longest > 400, `longest stored string is ${longest} characters, which is a truncation cap`);
});

test("destinations the chart spells with an accent are reachable", () => {
  for (const [q, expected] of [["Turkey", "Türkiye"], ["Türkiye", "Türkiye"], ["Turkiye", "Türkiye"],
    ["Curacao", "Curaçao"], ["Curaçao", "Curaçao"], ["Macao", "Macau"]]) {
    assert.equal(lookupCountry(q).country, expected, `${q} did not resolve`);
  }
});

test("a footnote comes back with its text, not just its number", () => {
  const r = lookupCountry("Belarus");
  assert.ok(r.footnotes.length, "Belarus carries footnote 6");
  for (const f of r.footnotes) {
    assert.equal(typeof f.number, "number");
    assert.ok(f.text?.length > 20, `footnote ${f.number} has no text`);
  }
  assert.match(r.footnotes[0].text, /746\.5|746\.8/, "footnote 6 is the Russia and Belarus sanctions");
});

// --- criterion 6 rescope: a verdict must carry the evidence for itself -------
//
// Until 0.4.0 a negative answer was a bare `licenseRequired: false` beside an
// empty `triggeredBy`. That is the answer a caller acts on by shipping, and it
// was the one they could not check without reading the chart themselves. The
// server's own history is the argument: 21 entries once lost their licence
// requirement in parsing and answered `false` for every destination, and
// nothing in the output looked wrong.

test("a negative verdict names every chart cell it read", () => {
  // 3A001 is NS Column 1 and AT Column 1; Canada carries neither.
  const r = checkLicense("3A001", "Canada");
  assert.equal(r.status, "ok");
  assert.equal(r.licenseRequired, false);
  assert.deepEqual(r.triggeredBy, []);

  assert.ok(r.checked.length > 0, "a false verdict with no cited cells is unverifiable");
  assert.ok(r.checked.every((c) => c.marked === false), "nothing may be marked when the verdict is false");
  for (const c of r.checked) {
    assert.ok(c.column, "each cited cell names its chart column");
    assert.ok(c.reasonName, "each cited cell expands its reason code");
  }
});

test("a positive verdict cites the unmarked cells too, not only the triggering ones", () => {
  const r = checkLicense("3A001", "Japan");
  assert.equal(r.licenseRequired, true);
  assert.ok(r.triggeredBy.length > 0);
  // `checked` is the whole grid row that was consulted, so the caller can see
  // what was considered and rejected as well as what fired.
  assert.ok(r.checked.length >= r.triggeredBy.length);
  const marked = r.checked.filter((c) => c.marked).map((c) => c.column).sort();
  assert.deepEqual(marked, r.triggeredBy.map((t) => t.column).sort());
});

test("every chart answer stamps the edition it was read from", () => {
  for (const args of [["3A001", "Japan"], ["3A001", "Canada"], ["0A983", "France"], ["0A501", "Iran"]]) {
    const r = checkLicense(...args);
    assert.equal(r.sourceEdition, SOURCE_EDITION, `${args.join("/")} must say how current it is`);
  }
});

test("even a refusal says how current the data is", () => {
  // A caller cannot tell a stale snapshot from a wrong one without this, and
  // "not in the Control List" is exactly the answer an old snapshot gets wrong.
  const refusals = [
    checkLicense("not-an-eccn", "Japan"),
    checkLicense("0A997", "Japan"),
    checkLicense("3A001", "Congo"),
    checkLicense("3A001", "United States"),
    lookupEccn("not-an-eccn"),
    lookupEccn("0A997"),
    lookupCountry("Nowhere"),
  ];
  for (const r of refusals) {
    assert.equal(r.sourceEdition, SOURCE_EDITION, `${r.status} must carry the edition`);
  }
});

test("a footnoted row still returns its footnotes alongside the verdict", () => {
  // Russia carries the sanctions footnote. The tool does not apply footnotes,
  // so a verdict on such a row is only safe if the footnote travels with it.
  const r = checkLicense("3A001", "Russia");
  assert.equal(r.status, "ok");
  assert.ok(Array.isArray(r.footnotes));
  if (r.footnotes.length) {
    assert.ok(r.footnotes.every((f) => f.number != null && f.text), "a bare footnote number is unreadable");
  }
});
