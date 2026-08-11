// Proposition 65 listing lookup.
//
// The design rule: a false "not listed" and a false "listed" are both
// expensive, in opposite directions. A missed listing is a warning that should
// have been on the product; a wrong hit is a warning that should not have been,
// which carries its own liability. So this library reports what the published
// list says, distinguishes "delisted" from "never listed", and never treats an
// absent match as a clearance.

import { CHEMICALS, EDITION } from "./data.mjs";

export { EDITION };

/** Listing mechanisms, from the list's own header notes. */
export const MECHANISMS = {
  AB: "Authoritative Bodies",
  SQE: "State's Qualified Experts",
  FR: "Formally Required to be labeled or identified",
  LC: "Labor Code",
};

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** CAS numbers are written with hyphens; compare on digits alone. */
export function normalizeCas(raw) {
  const s = String(raw ?? "").replace(/\s/g, "");
  return /^\d{2,7}-\d{2}-\d$/.test(s) ? s : null;
}

const byCas = new Map();
const byName = new Map();
for (const e of CHEMICALS) {
  // An entry can carry several CAS numbers; each one must find it.
  for (const cas of e.c) {
    if (!byCas.has(cas)) byCas.set(cas, []);
    byCas.get(cas).push(e);
  }
  const n = norm(e.n);
  if (!byName.has(n)) byName.set(n, []);
  byName.get(n).push(e);
}

/** What a "not listed" answer does not establish. Attached to every miss. */
const NOT_COVERED = [
  "The list is revised at least yearly, and this is the " + EDITION + " edition. A chemical listed since then will not appear here.",
  "A chemical can be listed under a different name or as part of a group listing with no CAS number, so an exact-match miss is not proof of absence.",
  "Prop 65 applies to exposure, not presence. A listed chemical below its safe harbour level may need no warning, and an unlisted one may still be regulated elsewhere.",
  "This is the California list only. It says nothing about REACH, RoHS, TSCA or any other regime.",
];

function present(e) {
  const out = {
    chemical: e.n,
    cas: e.c,
    toxicity: e.t || null,
    listingMechanism: e.m || null,
    mechanismName: e.m ? (MECHANISMS[e.m.split(/[,\s]/)[0]] ?? null) : null,
    dateListed: e.d || null,
    safeHarbourLevel: e.l || null,
    delisted: Boolean(e.x),
  };
  if (e.r) out.delistedNote = e.r;
  return out;
}

/**
 * Is a chemical on the Proposition 65 list?
 *
 * Accepts a CAS number or a chemical name. CAS is the reliable key; names are
 * matched exactly after normalisation, and a near miss returns candidates
 * rather than a guess.
 */
export function checkChemical(query) {
  const raw = String(query ?? "").trim();
  if (!raw) return { status: "invalid_query", message: "Give a CAS number or a chemical name." };

  const cas = normalizeCas(raw);
  let hits = cas ? byCas.get(cas) : byName.get(norm(raw));

  if (!hits && !cas) {
    // Name did not match exactly. Offer candidates instead of deciding.
    const q = norm(raw);
    const near = CHEMICALS.filter((e) => norm(e.n).includes(q)).slice(0, 12);
    if (near.length === 1) hits = near;
    else if (near.length > 1) {
      return {
        status: "ambiguous",
        query: raw,
        candidates: near.map((e) => ({ chemical: e.n, cas: e.c, delisted: Boolean(e.x) })),
        message: `"${raw}" matches ${near.length} entries on the list. Pick one, or query by CAS number.`,
      };
    }
  }

  if (!hits || hits.length === 0) {
    return {
      status: "not_found",
      query: raw,
      edition: EDITION,
      message: `"${raw}" is not on the ${EDITION} Proposition 65 list under that name or CAS number. This is not a clearance; see notCovered.`,
      notCovered: NOT_COVERED,
    };
  }

  const active = hits.filter((e) => !e.x);
  const removed = hits.filter((e) => e.x);

  // A chemical can be listed for several endpoints; report all of them.
  return {
    status: "ok",
    query: raw,
    listed: active.length > 0,
    entries: hits.map(present),
    delistedOnly: active.length === 0 && removed.length > 0,
    warningLikelyRequired: active.length > 0,
    edition: EDITION,
    message:
      active.length > 0
        ? `Listed under Proposition 65 (${EDITION} edition).`
        : `Was listed and has since been removed. A warning is not required on the basis of this listing.`,
    notCovered: NOT_COVERED,
  };
}

/** Substring search over chemical names, for when the exact name is unknown. */
export function searchChemicals(term, limit = 25) {
  const q = norm(term);
  if (!q) return { status: "invalid_query", message: "Give a name fragment to search for." };
  const hits = CHEMICALS.filter((e) => norm(e.n).includes(q));
  return {
    status: "ok",
    term: String(term).trim(),
    count: hits.length,
    truncated: hits.length > limit,
    results: hits.slice(0, limit).map((e) => ({
      chemical: e.n,
      cas: e.c,
      toxicity: e.t || null,
      dateListed: e.d || null,
      delisted: Boolean(e.x),
    })),
    edition: EDITION,
  };
}

/**
 * Chemicals listed on or after a date.
 *
 * Prop 65 gives twelve months from listing before a warning is required, so
 * "what was added recently" is a question with a deadline attached.
 */
export function listedSince(sinceYear) {
  const year = Number(sinceYear);
  if (!Number.isInteger(year) || year < 1986 || year > 2100) {
    return { status: "invalid_query", message: "Give a four-digit year from 1986 onwards." };
  }
  // Dates are ISO after generation. Entries whose source date did not convert
  // are excluded rather than guessed at, and counted so the gap is visible.
  const parseYear = (d) => {
    const m = /^(\d{4})-\d{2}-\d{2}$/.exec(String(d ?? ""));
    return m ? Number(m[1]) : null;
  };
  const hits = CHEMICALS.filter((e) => {
    const y = parseYear(e.d);
    return y !== null && y >= year && !e.x;
  });
  return {
    status: "ok",
    since: year,
    count: hits.length,
    results: hits
      .map((e) => ({ chemical: e.n, cas: e.c, toxicity: e.t || null, dateListed: e.d }))
      .sort((a, b) => String(b.dateListed).localeCompare(String(a.dateListed))),
    edition: EDITION,
    undatedEntries: CHEMICALS.filter((e) => !e.x && !/^\d{4}-\d{2}-\d{2}$/.test(e.d ?? "")).length,
    note:
      "A warning is generally required twelve months after a chemical is listed. " +
      "`undatedEntries` is how many active entries carry no parseable listing date " +
      "and are therefore absent from this answer regardless of the year given.",
  };
}

export function stats() {
  return {
    total: CHEMICALS.length,
    active: CHEMICALS.filter((e) => !e.x).length,
    delisted: CHEMICALS.filter((e) => e.x).length,
    withCas: CHEMICALS.filter((e) => e.c.length > 0).length,
    edition: EDITION,
  };
}
