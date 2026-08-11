#!/usr/bin/env node
// Generates packages/mcp-export-control/data.mjs from the eCFR XML of 15 CFR
// parts 738 and 774. Nothing else writes that file.
//
//   node scripts/gen-export-control.mjs                  # today's edition
//   node scripts/gen-export-control.mjs --date=2026-01-01
//   node scripts/gen-export-control.mjs --cache=/tmp/x   # reuse downloaded XML
//
// The first version of this data was produced by a script that was never
// committed, and every defect below shipped because of it. None were visible in
// the output, and the test suite exercised the library over the data rather than
// the data against its source, so all of them were green:
//
//   - Entries whose licence requirement is written as prose rather than as a
//     two-column table lost it entirely, and an entry with no controls answered
//     "no licence required" for every destination. 0A983 is implements of
//     torture and reads "a license is required for ALL destinations".
//   - Table rows carrying a trailing empty third cell were dropped (6D201).
//   - Control paragraphs sitting beside a table were dropped (1C350's CW).
//   - The "Reason for Control" line was split on whitespace without stopping at
//     the end of the line, so 20 entries carried the following paragraphs as
//     reason codes. 5E002 had 341 of them.
//   - XML entities were never decoded, so two destinations were stored as
//     "T&#xFC;rkiye" and "Cura&#xE7;ao" and could not be looked up by any
//     spelling.
//   - Strings were truncated at 220 characters mid-word, which hit 153 titles
//     and 70 control strings. A scope caveat is the operative text of a control,
//     so cutting it changes what the entry says.
//   - An entry whose heading is split across several <B> tags was skipped
//     (3D006).
//
// So the invariants at the bottom of this file are the point of it, more than
// the parsing is. Each one corresponds to a defect above and fails the build
// rather than writing a plausible-looking table. A parser that cannot read its
// source should stop, not guess: this data answers a question that carries
// criminal exposure, and a silent gap in it reads as permission.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "packages/mcp-export-control/data.mjs");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);
const CACHE = args.cache ?? null;

/**
 * The edition to label the data with, and to ask eCFR for.
 *
 * Today's date is the wrong default even though it returns the right content.
 * `SOURCE_EDITION` is quoted back to callers as what this data is current to,
 * and every tool description cites it, so it has to be the date the regulation
 * was last issued rather than the date someone happened to run this. It also
 * makes the output stable: labelling with today would produce a diff every run
 * and the refresh workflow could not tell a real amendment from the calendar.
 */
async function latestEdition() {
  const res = await fetch("https://www.ecfr.gov/api/versioner/v1/titles.json");
  if (!res.ok) throw new Error(`eCFR title index returned ${res.status}`);
  const title = (await res.json()).titles.find((t) => t.number === 15);
  if (!title?.latest_issue_date) throw new Error("no latest_issue_date for title 15");
  return title.latest_issue_date;
}

const DATE = args.date ?? (await latestEdition());

/** The sixteen reason-for-control codes. A column outside this set is a parse error. */
const REASON_CODES = new Set(["AT", "CB", "CC", "CW", "EI", "FC", "MT", "NP", "NS", "RS", "SI", "SL", "SS", "UN"]);

// ---------------------------------------------------------------- text

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  sect: "§", deg: "°", plusmn: "±", times: "×",
  micro: "µ", hellip: "...", bull: "*", ndash: "-", mdash: " - ",
  ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", eacute: "é",
};

/**
 * Curly quotes become straight and dashes become hyphens on the way in.
 *
 * The quotes matter because the Control List uses them as defined-term markers
 * ("software" is a definition, software is not) and a caller matching on the
 * string should not have to know which codepoint the typesetter used. The
 * dashes matter because CI bars U+2013 and U+2014 repo-wide as a machine-written
 * tell, and a data file of quoted federal text is not the place to carve an
 * exception into a rule that otherwise has none.
 */
function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m))
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\u2014/g, " - ")
    .replace(/\u2013/g, "-");
}

/**
 * Strip markup, decode, collapse whitespace. Never truncates.
 *
 * Inline emphasis tags close up rather than becoming a space, because headings
 * are broken across them to italicise a defined term and 3D006 would otherwise
 * read `' ECAD ' ( ' ECAD ' )`.
 */
function text(xml) {
  return decode(
    String(xml)
      .replace(/<\/?(B|I|E|EM|SU|SUP|SUB)\b[^>]*>/g, "")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

/** Cells of one table row, with each cell's colspan. */
function cells(row) {
  const out = [];
  const re = /<TD([^>]*?)(?:\/>|>([\s\S]*?)<\/TD>)/g;
  let m;
  while ((m = re.exec(row))) {
    out.push({ text: text(m[2] ?? ""), span: Number(/colspan="(\d+)"/.exec(m[1])?.[1] ?? 1) });
  }
  return out;
}

const rowsOf = (table) => {
  const body = table.includes("<TBODY>") ? table.slice(table.indexOf("<TBODY>")) : table;
  return [...body.matchAll(/<TR>([\s\S]*?)<\/TR>/g)].map((m) => m[1]);
};

const tablesIn = (xml) => [...xml.matchAll(/<TABLE[\s\S]*?<\/TABLE>/g)].map((m) => m[0]);

// ---------------------------------------------------------------- fetch

async function source(part) {
  const file = CACHE ? join(CACHE, `title-15-part-${part}-${DATE}.xml`) : null;
  if (file && existsSync(file)) return readFileSync(file, "utf8");
  const url = `https://www.ecfr.gov/api/versioner/v1/full/${DATE}/title-15.xml?part=${part}`;
  process.stderr.write(`fetching part ${part} at ${DATE}\n`);
  const res = await fetch(url, { headers: { "user-agent": "toolstop/export-control generator" } });
  if (!res.ok) throw new Error(`eCFR part ${part} returned ${res.status}`);
  const xml = await res.text();
  if (file) {
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(file, xml);
  }
  return xml;
}

// ---------------------------------------------------------------- chart

/**
 * The Commerce Country Chart, supplement no. 1 to part 738.
 *
 * Three row shapes, and missing any of them loses a destination: an ordinary
 * row of sixteen cells marked X, a referral row of one merged cell for the four
 * destinations part 746 governs instead, and a footnote row of no cells at all.
 * The column order is read from the header rather than assumed, because a
 * column inserted upstream would otherwise shift every mark by one and stay
 * invisible.
 */
function parseChart(xml) {
  const table = tablesIn(xml).find((t) => /<TH[^>]*>\s*CB\s*1\s*<\/TH>/.test(t));
  if (!table) throw new Error("country chart table not found");

  const header = [...table.matchAll(/<TH[^>]*>([\s\S]*?)<\/TH>/g)].map((m) => text(m[1]));
  const columns = header
    .map((h) => /^([A-Z]{2})\s*([123])$/.exec(h.replace(/\s+/g, " ").trim()))
    .filter(Boolean)
    .map((m) => m[1] + m[2]);

  const countries = {};
  const footnotes = {};

  for (const row of rowsOf(table)) {
    const c = cells(row);
    if (!c.length) continue;

    // A footnote is a numbered paragraph spanning the row, carrying a condition
    // the grid cannot show. It is a row of the same table as the destinations.
    if (c.length === 1 && /^\d+\s/.test(c[0].text)) {
      const m = /^(\d+)\s+(.+)$/s.exec(c[0].text);
      footnotes[Number(m[1])] = m[2];
      continue;
    }

    // Footnote markers ride on the end of the name: "Albania 2 3".
    const raw = c[0].text;
    const nm = /^(.*?)((?:\s+\d+)*)$/s.exec(raw);
    const name = nm[1].trim();
    const marks = nm[2].trim() ? nm[2].trim().split(/\s+/).map(Number) : [];
    if (!name) continue;

    const rest = c.slice(1);
    if (!rest.length) continue;
    if (rest.length === 1 && /EAR/.test(rest[0].text)) {
      countries[name] = { e: rest[0].text, ...(marks.length ? { f: marks } : {}) };
      continue;
    }
    if (rest.length !== columns.length) {
      throw new Error(`${name}: ${rest.length} cells against ${columns.length} columns`);
    }
    countries[name] = {
      c: columns.filter((_, i) => /^X/i.test(rest[i].text)),
      ...(marks.length ? { f: marks } : {}),
    };
  }
  return { columns, countries, footnotes };
}

// ---------------------------------------------------------------- control list

const SECTION_END = /List Based License Exceptions|Special Conditions for STA|List of Items Controlled|Reporting Requirements/;
const COLUMN_RE = /\b(AT|CB|CC|CW|EI|FC|MT|NP|NS|RS|SI|SL|SS|UN)\s*Column\s*([123])\b/i;

/** "NS Column 1." in the chart cell, or null when the chart does not decide it. */
function columnOf(s) {
  const m = COLUMN_RE.exec(s);
  return m ? m[1].toUpperCase() + m[2] : null;
}

/**
 * One entry's controls, from whichever of the four shapes the drafter used.
 *
 * The two-column table is the common one and the only one the previous
 * generator read. The others are not rare edge cases: they carry "a license is
 * required for ALL destinations", which is the strongest requirement in the
 * part, and they are how the CWC chemicals and the crime-control entries are
 * written.
 */
function parseControls(section) {
  const controls = [];

  for (const table of tablesIn(section)) {
    if (!/Country\s*chart/i.test(table) && !/Control\(s\)/i.test(table)) continue;
    for (const row of rowsOf(table)) {
      // Trailing empty cells are layout, not data. Dropping the row instead of
      // the padding is what lost 6D201's NP and AT controls.
      const c = cells(row).filter((x, i) => x.text || i < 2);
      if (!c.length || !c[0].text) continue;

      // An empty chart cell means the chart does not decide this control, and
      // the requirement is stated in the scope cell instead. 1E355 puts the
      // whole CWC rule there.
      if (c.length >= 2 && !c[1].text) {
        controls.push([c[0].text, c[0].text, columnOf(c[0].text)]);
        continue;
      }

      if (c.length === 1 || c[0].span > 1) {
        // Both halves merged into one cell: "CB applies to entire entry CB Column 2."
        const whole = c[0].text;
        const m = COLUMN_RE.exec(whole);
        if (m) {
          controls.push([whole.slice(0, m.index).trim(), whole.slice(m.index).trim(), columnOf(whole)]);
        } else {
          controls.push([whole, whole, null]);
        }
        continue;
      }
      controls.push([c[0].text, c[1].text, columnOf(c[1].text)]);
    }
  }

  // Prose controls: an FP-1 or P paragraph carrying "Control(s)" or an
  // "XX applies to" clause, outside any table.
  const prose = section.replace(/<TABLE[\s\S]*?<\/TABLE>/g, "");
  const paras = [...prose.matchAll(/<(FP-1|FP|P)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => text(m[2]));
  // "Control(s):", "Controls:" and a bare "Control(s)" heading followed by
  // paragraphs are all in use, sometimes without the <I> that marks the others.
  const LABEL = /^Controls?(\(s\))?\s*:?\s*/;
  let inControls = false;
  for (const p of paras) {
    const isLabel = LABEL.test(p);
    if (isLabel) inControls = true;
    if (/^(Reasons? for Control|LVS|GBS|CIV|TSR|STA|Related|Items|Note)\s*:/.test(p)) {
      if (!isLabel) inControls = false;
      continue;
    }
    const body = p.replace(LABEL, "").trim();
    if (!body) continue;
    const scoped = /^([A-Z]{2})(\s+and\s+[A-Z]{2})?\s+appl(y|ies)\s+to\b/.exec(body);
    // A paragraph the drafter labelled "Control(s)" is a control whatever it
    // says next. 0D001's is a one-line referral to the ITAR and carries none of
    // the usual phrasing; dropping it left the entry looking uncontrolled.
    if (!isLabel && !inControls && !scoped) continue;
    if (!isLabel && !scoped && !/license is required/i.test(body)) continue;
    // The scope is the clause naming what the control reaches; the requirement
    // is the whole paragraph, because that is where the answer actually is.
    const stop = body.indexOf(". ");
    const scope = scoped ? (stop > 0 ? body.slice(0, stop + 1) : body).trim() : body;
    controls.push([scope, body, columnOf(body)]);
  }

  return controls;
}

/**
 * The Control List, supplement no. 1 to part 774.
 *
 * An entry starts at an FP-2 heading whose text begins with an ECCN and runs to
 * the next one. The heading is read from the whole FP-2 block rather than its
 * first <B>, because a heading is sometimes broken across several tags to
 * italicise a defined term, and reading only the first one loses the title and
 * with it the entry (3D006).
 */
function parseCcl(xml) {
  // Only an FP-2 that opens with an ECCN starts an entry. The tag is also used
  // for a stray "Reason for Control:" line inside one (2B910), and treating
  // that as a boundary cut the entry off above its own control table.
  const heads = [...xml.matchAll(/<FP-2>([\s\S]*?)<\/FP-2>/g)]
    .map((m) => ({ at: m.index, end: m.index + m[0].length, heading: text(m[1]) }))
    .filter((h) => /^\d[A-E]\d{3}\b/.test(h.heading));
  const eccns = {};

  for (let i = 0; i < heads.length; i++) {
    const [, eccn, title] = /^(\d[A-E]\d{3})\b[.\s]*([\s\S]*)$/.exec(heads[i].heading);
    const body = xml.slice(heads[i].end, i + 1 < heads.length ? heads[i + 1].at : xml.length);

    // The licence section runs from the heading to the first following section,
    // and starts at the "License Requirements" header when there is one. Some
    // entries have no such header and go straight to the reason line (3A001),
    // so anchoring on it alone found a later mention deep in the item list and
    // read a section that had already ended.
    const endAt = body.search(SECTION_END);
    const lrAt = body.search(/License Requirements/);
    const limit = endAt >= 0 ? endAt : body.length;
    const section = lrAt >= 0 && lrAt < limit ? body.slice(lrAt, limit) : body.slice(0, limit);

    // An entry with no licence text of its own is a pointer to another
    // authority, usually the ITAR. It has nothing to parse, as opposed to
    // something this script failed to parse, and only the former is allowed
    // through with no controls.
    const hasLicenceText = /Reasons? for Control|Controls?(\(s\))?\s*:/.test(text(section));

    // Only the reason line itself. Reading past it is what turned the following
    // paragraphs into 341 reason codes on 5E002.
    const rm = /Reasons? for Control\s*:?\s*(?:<\/I>)?([\s\S]*?)<\/(?:FP-1|FP|P)>/.exec(section);
    const reasons = rm
      ? [...new Set(text(rm[1]).split(/[^A-Za-z]+/).filter((t) => REASON_CODES.has(t.toUpperCase())).map((t) => t.toUpperCase()))]
      : [];

    eccns[eccn] = {
      c: hasLicenceText ? parseControls(section) : [],
      r: reasons,
      t: title.trim(),
      ...(hasLicenceText ? {} : { n: 1 }),
    };
  }
  return eccns;
}

// ---------------------------------------------------------------- invariants

/**
 * Every check here is a defect that shipped. They run before anything is
 * written, because the failure mode of this generator is not a crash, it is a
 * table that looks complete and quietly answers "no licence required".
 */
function verify({ columns, countries, footnotes }, eccns) {
  const fail = [];
  const check = (cond, msg) => { if (!cond) fail.push(msg); };

  check(columns.length === 16, `chart has ${columns.length} columns, expected 16`);
  check(Object.keys(countries).length >= 190, `only ${Object.keys(countries).length} destinations`);
  const referrals = Object.keys(countries).filter((c) => countries[c].e);
  check(referrals.length === 4, `${referrals.length} referral destinations, expected 4: ${referrals}`);
  for (const c of ["Canada", "Japan", "Germany", "China", "Russia", "Türkiye", "Curaçao"]) {
    check(countries[c], `${c} missing from the chart`);
  }
  for (const [name, row] of Object.entries(countries)) {
    for (const col of row.c ?? []) check(columns.includes(col), `${name}: column ${col} is not on the chart`);
    for (const f of row.f ?? []) check(footnotes[f], `${name}: footnote ${f} has no text`);
  }

  check(Object.keys(eccns).length >= 600, `only ${Object.keys(eccns).length} Control List entries`);

  for (const [eccn, e] of Object.entries(eccns)) {
    check(/^\d[A-E]\d{3}$/.test(eccn), `${eccn} is not a well-formed ECCN`);
    check(e.t.length > 0, `${eccn} has no title`);

    // The one that matters. An entry with a licence section and no control
    // parsed out of it is a control this script could not read, and it will be
    // served as "the chart requires nothing".
    check(e.n === 1 || e.c.length > 0, `${eccn} has a License Requirements section but no control was parsed`);

    for (const r of e.r) check(REASON_CODES.has(r), `${eccn}: "${r}" is not a reason-for-control code`);
    for (const [scope, requirement, column] of e.c) {
      check(scope.length > 0 && requirement.length > 0, `${eccn}: empty control text`);
      check(column === null || columns.includes(column), `${eccn}: column ${column} is not on the chart`);
    }
  }

  // Truncation and entity bugs are both invisible in a spot check, so assert
  // the shape of every string rather than reading a sample of them.
  const strings = [
    ...Object.keys(countries),
    ...Object.values(countries).map((r) => r.e ?? ""),
    ...Object.values(footnotes),
    ...Object.values(eccns).flatMap((e) => [e.t, ...e.c.flatMap((c) => [c[0], c[1]])]),
  ];
  for (const s of strings) {
    check(!/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/i.test(s), `undecoded entity in: ${s.slice(0, 80)}`);
    check(!/[\u2013\u2014]/.test(s), `em or en dash in: ${s.slice(0, 80)}`);
  }

  if (fail.length) {
    process.stderr.write(`\n${fail.length} invariant failures:\n`);
    for (const f of fail.slice(0, 40)) process.stderr.write(`  ${f}\n`);
    if (fail.length > 40) process.stderr.write(`  ... and ${fail.length - 40} more\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- write

const chart = parseChart(await source(738));
const eccns = parseCcl(await source(774));
verify(chart, eccns);

const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

const out = `// GENERATED by scripts/gen-export-control.mjs from eCFR. Do not hand-edit.
//
//   node scripts/gen-export-control.mjs --date=${DATE}
//
// Commerce Country Chart: 15 CFR part 738, Supplement No. 1.
// Commerce Control List: 15 CFR part 774, Supplement No. 1.
// Both are US federal regulation and therefore public domain.
//
// COUNTRIES: { c: marked chart columns, f: footnote numbers, e: referral text
//              for the destinations part 746 governs instead of the chart }
// ECCNS:     { t: heading, r: reason codes, n: 1 when the entry carries no
//              License Requirements section of its own (it points at the ITAR),
//              c: [scope, requirement, chart column or null] }
//
// An entry with an empty \`c\` cannot be answered from this data and lib.mjs
// returns \`indeterminate\` for it rather than a verdict. The generator refuses
// to write one that has a licence section, so the remainder are entries the
// source itself leaves to another authority.
export const SOURCE_EDITION = ${JSON.stringify(DATE)};
export const CHART_COLUMNS = ${JSON.stringify(chart.columns)};
export const FOOTNOTES = ${JSON.stringify(chart.footnotes)};
export const COUNTRIES = ${JSON.stringify(sorted(chart.countries))};
export const ECCNS = ${JSON.stringify(sorted(eccns))};
`;

writeFileSync(OUT, out);
process.stderr.write(
  `wrote ${OUT}\n  ${Object.keys(chart.countries).length} destinations, ` +
  `${Object.keys(chart.footnotes).length} footnotes, ${Object.keys(eccns).length} ECCNs, ` +
  `${Object.values(eccns).filter((e) => !e.c.length).length} without controls\n`,
);
