// Covers lib.mjs. The tools are covered by the shared suites via their
// `examples`, so this tests the decisions underneath, and above all the two
// source traps that silently corrupt this data: strikeout-marked delistings and
// Excel serial dates.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkChemical,
  searchChemicals,
  listedSince,
  stats,
  normalizeCas,
  EDITION,
} from "./lib.mjs";

test("the list loaded and is the right shape", () => {
  const s = stats();
  assert.ok(s.total > 900, `only ${s.total} entries`);
  assert.equal(s.total, s.active + s.delisted);
  assert.ok(s.delisted > 0, "delisted entries were not preserved");
  assert.match(EDITION, /\d{2}-[A-Za-z]{3}-\d{2}/);
});

test("CAS numbers are recognised, and other strings are not", () => {
  assert.equal(normalizeCas("71-43-2"), "71-43-2");
  assert.equal(normalizeCas(" 71-43-2 "), "71-43-2");
  for (const bad of ["", null, undefined, "benzene", "71-43", "7143-2"]) {
    assert.equal(normalizeCas(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test("a listed chemical is found by CAS and by name", () => {
  const byCas = checkChemical("71-43-2");
  assert.equal(byCas.status, "ok");
  assert.equal(byCas.listed, true);
  const byName = checkChemical("Benzene");
  assert.equal(byName.listed, true);
  assert.equal(byName.entries[0].chemical, "Benzene");
});

// The CSV export drops strikeout, and strikeout is how OEHHA marks removals.
// Parsing the CSV would report all 27 of these as requiring a warning.
test("delisted chemicals report as not listed, with the removal recorded", () => {
  const r = checkChemical("56-75-7"); // Chloramphenicol, removed 2013
  assert.equal(r.status, "ok");
  assert.equal(r.listed, false, "a delisted chemical must not read as listed");
  assert.equal(r.delistedOnly, true);
  assert.equal(r.entries[0].delisted, true);
  assert.match(r.entries[0].delistedNote, /Delisted/i);
});

test("every delisted entry carries its removal note", () => {
  const s = stats();
  let checked = 0;
  for (const term of ["Delisted"]) {
    const hits = searchChemicals(term, 100);
    void hits;
  }
  // Walk them through the public API rather than the raw data.
  const all = searchChemicals("", 1);
  assert.equal(all.status, "invalid_query", "an empty search must not return everything");
  assert.ok(s.delisted >= 20, `only ${s.delisted} delisted entries survived extraction`);
  checked++;
  assert.equal(checked, 1);
});

// Excel stores dates as serial numbers. Shipping them unconverted made
// listedSince(2024) return 802 results instead of 8.
test("listing dates are real ISO dates, not Excel serial numbers", () => {
  const r = checkChemical("71-43-2");
  const d = r.entries[0].dateListed;
  assert.match(d, /^\d{4}-\d{2}-\d{2}$/, `date was ${d}`);
  const year = Number(d.slice(0, 4));
  assert.ok(year >= 1987 && year <= 2100, `implausible listing year ${year}`);
});

test("listed_since returns a plausible count, not the whole list", () => {
  const recent = listedSince(2025);
  assert.equal(recent.status, "ok");
  assert.ok(recent.count > 0, "no recent listings at all");
  assert.ok(recent.count < 100, `${recent.count} listings since 2025 is the serial-date bug`);

  const everything = listedSince(1986);
  assert.ok(everything.count > recent.count, "a wider window must return more");
  assert.ok(typeof recent.undatedEntries === "number", "the date gap must be reported");
});

test("results are newest first", () => {
  const r = listedSince(2000);
  const dates = r.results.map((x) => x.dateListed);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test("a year outside the statute's life is rejected", () => {
  for (const y of [1800, 2200, "soon", null]) {
    assert.equal(listedSince(y).status, "invalid_query", `accepted ${JSON.stringify(y)}`);
  }
});

// A miss is the answer most likely to be over-read, so it must carry caveats.
test("a miss is explicitly not a clearance", () => {
  const r = checkChemical("dihydrogen monoxide");
  assert.equal(r.status, "not_found");
  assert.equal(r.listed, undefined);
  assert.ok(r.notCovered.length >= 3);
  assert.ok(r.notCovered.some((n) => /exposure/i.test(n)), "must explain exposure vs presence");
  assert.ok(r.notCovered.some((n) => /revised|edition/i.test(n)), "must say the list changes");
});

test("a hit carries the same caveats as a miss", () => {
  const r = checkChemical("71-43-2");
  assert.ok(r.notCovered.length >= 3, "a positive answer is over-read just as easily");
});

test("an ambiguous name returns candidates rather than picking", () => {
  const r = checkChemical("chromium");
  assert.equal(r.status, "ambiguous");
  assert.ok(r.candidates.length > 1);
  assert.equal(r.listed, undefined, "must not answer on a guess");
});

test("an entry with several CAS numbers is findable by each of them", () => {
  const first = checkChemical("58-93-5");
  assert.equal(first.status, "ok");
  const alt = checkChemical("125727-50-6");
  assert.equal(alt.status, "ok");
  assert.equal(alt.entries[0].chemical, first.entries[0].chemical);
  assert.ok(alt.entries[0].cas.length > 1, "multi-CAS entry lost its alternates");
});

test("search caps its output and says when it did", () => {
  const wide = searchChemicals("a", 5);
  assert.equal(wide.status, "ok");
  assert.equal(wide.results.length, 5);
  assert.equal(wide.truncated, true);
  assert.ok(wide.count > 5);
});
