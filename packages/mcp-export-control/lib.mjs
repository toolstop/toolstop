// Licence-requirement lookup against the Commerce Country Chart.
//
// The whole design rule: this library reports what the published tables say and
// refuses to infer anything they do not. It never classifies a product into an
// ECCN, never guesses which country was meant, and never reports "no licence
// required" without saying what that answer does not cover.

import { COUNTRIES, ECCNS, FOOTNOTES, SOURCE_EDITION } from "./data.mjs";

export { SOURCE_EDITION };

/** Reason-for-control codes, expanded. From 15 CFR 738.2(d). */
export const REASON_CODES = {
  AT: "Anti-Terrorism",
  CB: "Chemical & Biological Weapons",
  CC: "Crime Control",
  CW: "Chemical Weapons Convention",
  EI: "Encryption Items",
  FC: "Firearms Convention",
  MT: "Missile Technology",
  NP: "Nuclear Nonproliferation",
  NS: "National Security",
  RS: "Regional Stability",
  SI: "Significant Items",
  SL: "Surreptitious Listening",
  SS: "Short Supply",
  UN: "United Nations Embargo",
};

/** Common names and abbreviations for destinations the chart spells differently. */
const ALIASES = {
  uk: "United Kingdom",
  "great britain": "United Kingdom",
  britain: "United Kingdom",
  "south korea": "Korea, South",
  "republic of korea": "Korea, South",
  "north korea": "Korea, North",
  "dprk": "Korea, North",
  "prc: china": "China",
  "peoples republic of china": "China",
  "people's republic of china": "China",
  "mainland china": "China",
  "russian federation": "Russia",
  "uae": "United Arab Emirates",
  "vietnam": "Vietnam",
  "burma": "Burma",
  "myanmar": "Burma",
  "czechia": "Czech Republic",
  "holland": "Netherlands",
  "ivory coast": "Cote d'Ivoire",
  "cape verde": "Cabo Verde",
  "swaziland": "Eswatini",
  // The chart says Türkiye, which normalises to "turkiye" and needs no alias.
  // The entry here used to point the other way, at a spelling the chart does
  // not carry, so it never resolved anything.
  "turkey": "Türkiye",
  "macao": "Macau",
};

/**
 * Footnote numbers plus the text they stand for.
 *
 * The numbers alone were what the chart row carried, and a bare `[2, 3]` is
 * unreadable: footnote 6 is the Russia and Belarus sanctions and footnote 8 is
 * Crimea, so these are conditions that change the answer, not citations.
 */
function footnotesOf(row) {
  return (row.f ?? []).map((n) => ({ number: n, text: FOOTNOTES[n] ?? null }));
}

/**
 * The United States is not a row on the chart, because the chart lists export
 * *destinations*. Answering "unknown country" would read as a data gap and
 * invite a retry, so this is called out as the distinct thing it is.
 */
const DOMESTIC = new Set(["united states", "usa", "us", "u s a", "america", "united states of america"]);

const norm = (s) => String(s ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

function domesticResult() {
  return {
    status: "not_a_destination",
    message:
      "The United States is not on the Commerce Country Chart, which lists export destinations. " +
      "A shipment within the United States is not an export and the chart does not govern it. " +
      "Note that releasing controlled technology to a foreign person inside the US is a deemed " +
      "export and is controlled separately; see 15 CFR 734.13.",
  };
}

export function normalizeEccn(raw) {
  const s = String(raw ?? "").toUpperCase().replace(/\s+/g, "");
  return /^\d[A-E]\d{3}$/.test(s) ? s : null;
}

/**
 * Resolve a destination to a chart row.
 *
 * Returns `{ match }` on a confident hit, or `{ candidates }` when it is not
 * certain. It deliberately never picks for the caller: "Congo" is two
 * countries with different control columns, and choosing one silently would be
 * the worst failure this tool could have.
 */
export function resolveCountry(raw) {
  const q = norm(raw);
  if (!q) return { candidates: [] };

  const names = Object.keys(COUNTRIES);
  const exact = names.find((n) => norm(n) === q);
  if (exact) return { match: exact };

  const alias = ALIASES[q];
  if (alias && COUNTRIES[alias]) return { match: alias };

  // "Korea, South" should be reachable as "south korea" and vice versa.
  const flipped = names.find((n) => {
    const parts = norm(n).split(" ");
    return parts.length > 1 && parts.slice(1).concat(parts[0]).join(" ") === q;
  });
  if (flipped) return { match: flipped };

  const candidates = names.filter((n) => norm(n).includes(q) || q.includes(norm(n)));
  if (candidates.length === 1) return { match: candidates[0] };
  return { candidates: candidates.slice(0, 12) };
}

/**
 * An entry the country chart does not decide, which must never come back as
 * `licenseRequired: false`.
 *
 * Two kinds reach here. An entry whose controls exist but name no chart column:
 * 0A983 reads "a license is required for ALL destinations, regardless of
 * end-use", and reporting that the chart requires nothing would be the exact
 * inversion of it. And an entry with no licence requirements of its own, which
 * is a pointer to another authority, usually the ITAR. A State Department
 * licence is not the absence of a requirement either.
 *
 * `licenseRequired` is deliberately absent rather than false. The field means
 * "the chart decided and the answer was no", and neither of these is that.
 */
function indeterminateResult(eccn, entry) {
  const controls = entry.c.map(([scope, requirement]) => ({ scope, requirement }));
  return {
    status: "indeterminate",
    eccn,
    title: entry.t,
    reasons: (entry.r ?? []).map((r) => ({ code: r, name: REASON_CODES[r] ?? null })),
    controlsNotOnChart: controls,
    message: controls.length
      ? `${eccn} is controlled, but by requirements the Commerce Country Chart does not decide, so the ` +
        "chart cannot answer for it. The requirement text is returned verbatim in `controlsNotOnChart` " +
        "and often requires a licence to every destination. Read it before treating anything as cleared."
      : `${eccn} carries no licence requirements of its own in the ${SOURCE_EDITION} Control List. Entries ` +
        "in this state point at another authority, usually the ITAR, and the heading returned here names " +
        "it. This is not a finding that no licence is required; see 22 CFR parts 120 through 130.",
    notCovered: NOT_COVERED,
  };
}

/** Every caveat that a chart answer does not cover. Attached to every result. */
const NOT_COVERED = [
  "End-user and end-use controls: the Entity List, Denied Persons, Unverified List and the part 744 prohibitions apply regardless of this answer.",
  "Licence exceptions in part 740, which may authorise an export the chart says needs a licence.",
  "Embargoes and special controls in part 746.",
  "Whether the ECCN itself is correct. Classification is the exporter's responsibility.",
  "Deemed exports, reexports, and transfers within a country.",
];

/**
 * Does the Commerce Country Chart require a licence for this ECCN to this
 * destination?
 */
export function checkLicense(eccnRaw, countryRaw) {
  const eccn = normalizeEccn(eccnRaw);
  if (!eccn) {
    return {
      status: "invalid_eccn",
      message: `"${String(eccnRaw ?? "")}" is not an ECCN. An ECCN is a digit, a letter A to E, then three digits, for example 3A001.`,
    };
  }

  const entry = ECCNS[eccn];
  if (!entry) {
    return {
      status: "unknown_eccn",
      eccn,
      message: `${eccn} is not in the Commerce Control List edition of ${SOURCE_EDITION}. It may have been removed, or it may never have existed. Do not read this as "no licence required".`,
    };
  }

  if (DOMESTIC.has(norm(countryRaw))) return { ...domesticResult(), eccn };

  const resolved = resolveCountry(countryRaw);
  if (!resolved.match) {
    return {
      status: "ambiguous_country",
      eccn,
      candidates: resolved.candidates,
      message: resolved.candidates.length
        ? `"${String(countryRaw ?? "")}" matches more than one destination on the chart. Ask which one rather than assuming.`
        : `"${String(countryRaw ?? "")}" is not a destination on the Commerce Country Chart.`,
    };
  }

  const country = resolved.match;
  const row = COUNTRIES[country];

  if (row.e) {
    return {
      status: "embargoed",
      eccn,
      country,
      referral: row.e,
      message: `${country} is a special-controls destination. The Commerce Country Chart does not answer this; ${row.e}`,
      notCovered: NOT_COVERED,
    };
  }

  // Nothing on this entry is decided by the chart, so the chart has no verdict
  // to give. An entry with *some* chart control is answered normally, with the
  // off-chart ones surfaced alongside.
  if (!entry.c.some((c) => c[2])) return indeterminateResult(eccn, entry);

  const marks = new Set(row.c);
  const triggered = [];
  const notOnChart = [];
  for (const [scope, chartText, column] of entry.c) {
    if (column) {
      if (marks.has(column)) triggered.push({ reason: column.slice(0, 2), column, scope, reasonName: REASON_CODES[column.slice(0, 2)] ?? null });
    } else {
      notOnChart.push({ scope, requirement: chartText });
    }
  }

  return {
    status: "ok",
    eccn,
    title: entry.t,
    country,
    licenseRequired: triggered.length > 0,
    triggeredBy: triggered,
    controlsNotOnChart: notOnChart,
    countryColumns: row.c,
    footnotes: footnotesOf(row),
    sourceEdition: SOURCE_EDITION,
    notCovered: NOT_COVERED,
  };
}

export function lookupEccn(eccnRaw) {
  const eccn = normalizeEccn(eccnRaw);
  if (!eccn) return { status: "invalid_eccn", message: `"${String(eccnRaw ?? "")}" is not a well-formed ECCN.` };
  const e = ECCNS[eccn];
  if (!e) return { status: "unknown_eccn", eccn, message: `${eccn} is not in the ${SOURCE_EDITION} Commerce Control List.` };
  if (!e.c.some((c) => c[2])) {
    return {
      ...indeterminateResult(eccn, e),
      controls: e.c.map(([scope, requirement, column]) => ({ scope, requirement, column })),
      chartDetermined: false,
      sourceEdition: SOURCE_EDITION,
    };
  }
  return {
    status: "ok",
    eccn,
    title: e.t,
    reasons: e.r.map((r) => ({ code: r, name: REASON_CODES[r] ?? null })),
    controls: e.c.map(([scope, chart, column]) => ({ scope, requirement: chart, column })),
    chartDetermined: e.c.some(([, , c]) => c),
    sourceEdition: SOURCE_EDITION,
  };
}

export function lookupCountry(countryRaw) {
  if (DOMESTIC.has(norm(countryRaw))) return domesticResult();
  const resolved = resolveCountry(countryRaw);
  if (!resolved.match) {
    return {
      status: resolved.candidates.length ? "ambiguous_country" : "unknown_country",
      candidates: resolved.candidates,
      message: `"${String(countryRaw ?? "")}" did not resolve to exactly one destination on the chart.`,
    };
  }
  const country = resolved.match;
  const row = COUNTRIES[country];
  if (row.e) return { status: "embargoed", country, referral: row.e, sourceEdition: SOURCE_EDITION };
  return {
    status: "ok",
    country,
    columns: row.c.map((c) => ({ column: c, reason: c.slice(0, 2), reasonName: REASON_CODES[c.slice(0, 2)] ?? null })),
    footnotes: footnotesOf(row),
    sourceEdition: SOURCE_EDITION,
  };
}

export function listCountries() {
  return Object.keys(COUNTRIES).sort();
}
