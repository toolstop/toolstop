// The single source of truth for this server. Both transports import this and
// nothing else.
//
// The governing rule for every description here: this server reports what two
// published federal tables say. It does not classify products, it does not
// guess destinations, and it never lets "the chart says no licence" be read as
// "you may export". Export decisions carry criminal exposure, so a confident
// wrong answer is worse than an unhelpful one.

import { checkLicense, lookupEccn, lookupCountry, REASON_CODES, SOURCE_EDITION } from "./lib.mjs";

const STATUSES = [
  "ok",
  "embargoed",
  "indeterminate",
  "invalid_eccn",
  "unknown_eccn",
  "unknown_country",
  "not_a_destination",
  "ambiguous_country",
];

const STATUS_PROPERTY = {
  type: "string",
  enum: STATUSES,
  description:
    "Outcome of the lookup. Only `ok` carries an answer. `embargoed` means the " +
    "chart does not govern the destination. `indeterminate` means the entry has " +
    "no country-chart control in this data and the chart cannot answer for it, " +
    "which is not the same as no licence being required. `ambiguous_country` " +
    "means the name matched more than one row and you must ask which was meant.",
};

export default {
  name: "export-control",
  version: "0.2.0",
  instructions:
    "Answers one question: does the Commerce Country Chart require an export " +
    "licence for a given ECCN to a given destination? It reads two published " +
    "tables, the Commerce Country Chart (15 CFR part 738, Supplement No. 1) " +
    "and the Commerce Control List (15 CFR part 774, Supplement No. 1), both " +
    "US federal regulation and public domain, from the " + SOURCE_EDITION +
    " edition.\n\n" +
    "Call these tools instead of recalling export rules from memory. The " +
    "chart is a 200-by-16 grid that changes by Federal Register amendment, " +
    "getting one cell wrong flips the answer, and the penalty for an " +
    "unlicensed export runs to the greater of about $300,000 or twice the " +
    "transaction value per violation, with criminal exposure.\n\n" +
    "**This server cannot tell you an item's ECCN, and you must not guess " +
    "one.** Classification is the exporter's legal responsibility and it " +
    "depends on the item's technical parameters, not its name. If you do not " +
    "have an ECCN, say so and stop; do not pick a plausible-looking one and " +
    "run it through check_export_license, because the answer will be " +
    "confident and meaningless.\n\n" +
    "Choosing between the tools: with an ECCN and a destination, call " +
    "check_export_license, which is the whole point of the server. Use " +
    "lookup_eccn to read one entry's reasons for control and their scope " +
    "caveats. Use lookup_country to see which control columns a destination " +
    "carries. Country names must match the chart's own spelling; both tools " +
    "return `candidates` rather than choosing when a name is ambiguous, and " +
    "you should put that choice to a human rather than picking.\n\n" +
    "Some entries write their licence requirement as prose rather than as a " +
    "chart column, and some are pointers to the ITAR carrying no EAR " +
    "requirement at all. Those return `indeterminate` rather than an answer, " +
    "because a chart verdict computed from an entry with no chart controls " +
    "would read as `licenseRequired: false` for items that in fact require a " +
    "licence to every destination. Treat `indeterminate` as unanswered and go " +
    "to the regulation.\n\n" +
    "A result of `licenseRequired: false` means only that the country chart " +
    "does not require one for that ECCN. It is not permission to export. The " +
    "`notCovered` array on every answer lists what still applies, including " +
    "the Entity List and other end-user controls, the part 746 embargoes, and " +
    "licence exceptions that may change the answer in the other direction.\n\n" +
    "If a lookup here disagrees with the current regulation, the data is a " +
    "snapshot and the regulation is the authority. Report it at " +
    "https://github.com/toolstop/toolstop/issues.",

  tools: [
    {
      name: "check_export_license",
      title: "Does the country chart require an export licence",
      description:
        "Given an ECCN and a destination country, report whether the Commerce " +
        "Country Chart requires an export licence, and which reasons for " +
        "control trigger it. Use this when someone is about to ship or " +
        "transfer a controlled item abroad and needs the licence question " +
        "answered before it moves. Returns the triggering reasons with the " +
        "scope text from the Control List entry, because many controls apply " +
        "to only part of an entry, plus any controls that are not decided by " +
        "the chart at all. A `false` result means the chart alone does not " +
        "require a licence; it is not clearance to export, and it says nothing " +
        "about the Entity List, embargoes, end-use controls, or whether the " +
        "ECCN is the right one. Entries whose requirement is not written as a " +
        "chart column return `indeterminate` instead of a verdict, and that is " +
        "an unanswered question rather than a negative answer. This tool cannot " +
        "classify an item into an ECCN and will not try.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          eccn: {
            type: "string",
            description: "Export Control Classification Number, e.g. 3A001. Digit, letter A to E, three digits.",
            maxLength: 16,
          },
          country: {
            type: "string",
            description: "Destination country as spelled on the Commerce Country Chart, e.g. Japan or Korea, South.",
            maxLength: 64,
          },
        },
        required: ["eccn", "country"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          status: STATUS_PROPERTY,
          eccn: { type: "string", description: "The normalised ECCN." },
          country: { type: "string", description: "The chart row that was matched." },
          licenseRequired: {
            type: "boolean",
            description:
              "Whether the country chart requires a licence. Present only when status is `ok`. " +
              "False does not mean the export is permitted.",
          },
          triggeredBy: {
            type: "array",
            description: "Each control whose chart column is marked for this destination, with its scope caveat.",
            items: { type: "object" },
          },
          controlsNotOnChart: {
            type: "array",
            description: "Controls on this entry that the chart does not decide, with the requirement text verbatim.",
            items: { type: "object" },
          },
          candidates: {
            type: "array",
            description: "Possible destinations, when the country name matched more than one row.",
            items: { type: "string" },
          },
          notCovered: {
            type: "array",
            description: "What this answer does not address. Always present on an answered lookup.",
            items: { type: "string" },
          },
          title: { type: "string", description: "The Control List entry heading, on an indeterminate result." },
          message: { type: "string", description: "Why no verdict was returned, when status is not `ok`." },
        },
        required: ["status"],
      },
      examples: [
        {
          args: { eccn: "3A001", country: "Japan" },
          expect: { status: "ok", eccn: "3A001", country: "Japan", licenseRequired: true },
        },
        {
          // The requirement is "a license is required for ALL destinations",
          // written as prose. An empty control list must not become `false`.
          args: { eccn: "0A983", country: "France" },
          expect: { status: "indeterminate", eccn: "0A983" },
        },
        {
          args: { eccn: "3A001", country: "Canada" },
          expect: { status: "ok", licenseRequired: false },
        },
        {
          args: { eccn: "0A501", country: "Iran" },
          expect: { status: "embargoed", country: "Iran" },
        },
        {
          args: { eccn: "3A001", country: "Congo" },
          expect: { status: "ambiguous_country" },
        },
        {
          args: { eccn: "not-an-eccn", country: "Japan" },
          expect: { status: "invalid_eccn" },
        },
      ],
      handler: ({ eccn, country }) => checkLicense(eccn, country),
    },

    {
      name: "lookup_eccn",
      title: "Read a Control List entry's reasons for control",
      description:
        "Look up one ECCN on the Commerce Control List and return its title, " +
        "its reasons for control, and the chart column each reason maps to. " +
        "Use this to understand why an item is controlled, or to see the scope " +
        "caveats before relying on a licence answer, since a control often " +
        "applies to only some sub-paragraphs of an entry. Some entries are not " +
        "decided by the country chart at all, and those return " +
        "`chartDetermined: false` with the requirement text instead, or " +
        "`indeterminate` when the entry carries no chart control at all. Knowing an " +
        "entry's reasons for control does not tell you whether a licence is " +
        "required for a destination; pass the ECCN to check_export_license for " +
        "that. This tool cannot tell you whether an item falls under this ECCN.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          eccn: { type: "string", description: "Export Control Classification Number, e.g. 5A002.", maxLength: 16 },
        },
        required: ["eccn"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          status: STATUS_PROPERTY,
          eccn: { type: "string", description: "The normalised ECCN." },
          title: { type: "string", description: "The entry heading as published." },
          reasons: {
            type: "array",
            description: "Reason-for-control codes on the entry, with their expanded names.",
            items: { type: "object" },
          },
          controls: {
            type: "array",
            description: "Each control, its scope text, and the chart column or other requirement it maps to.",
            items: { type: "object" },
          },
          chartDetermined: {
            type: "boolean",
            description: "Whether any control on this entry is decided by the country chart.",
          },
        },
        required: ["status"],
      },
      examples: [
        {
          args: { eccn: "5A002" },
          expect: { status: "ok", eccn: "5A002", chartDetermined: true },
        },
        {
          args: { eccn: "0A997" },   // well-formed, absent from the Control List
          expect: { status: "unknown_eccn" },
        },
        {
          args: { eccn: "0A002" },   // present, but a pointer to the ITAR
          expect: { status: "indeterminate", chartDetermined: false },
        },
      ],
      handler: ({ eccn }) => lookupEccn(eccn),
    },

    {
      name: "lookup_country",
      title: "Which control columns a destination carries",
      description:
        "Return the Commerce Country Chart row for a destination: which of the " +
        "sixteen control columns are marked, with each reason expanded. Use " +
        "this to see how heavily controlled a destination is, or to check the " +
        "chart's spelling of a country before another lookup. Special-controls " +
        "destinations such as Cuba, Iran, North Korea and Syria return " +
        "`embargoed` with a referral, because the chart does not govern them " +
        "and reading a blank row as permission would be badly wrong. A marked " +
        "column means a licence is required for items controlled for that " +
        "reason; it says nothing about any particular item until you pair it " +
        "with an ECCN.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          country: { type: "string", description: "Destination country name, e.g. Germany.", maxLength: 64 },
        },
        required: ["country"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          status: STATUS_PROPERTY,
          country: { type: "string", description: "The chart row that was matched." },
          columns: {
            type: "array",
            description: "Marked control columns, each with its reason code and expanded name.",
            items: { type: "object" },
          },
          referral: {
            type: "string",
            description: "Where to look instead, for a special-controls destination.",
          },
          candidates: {
            type: "array",
            description: "Possible destinations, when the name matched more than one row.",
            items: { type: "string" },
          },
          footnotes: {
            type: "array",
            description: "Chart footnote numbers on this row, which carry conditions the grid does not show.",
            items: { type: "number" },
          },
        },
        required: ["status"],
      },
      examples: [
        {
          args: { country: "Germany" },
          expect: { status: "ok", country: "Germany" },
        },
        {
          args: { country: "South Korea" },
          expect: { status: "ok", country: "Korea, South" },
        },
        {
          args: { country: "Cuba" },
          expect: { status: "embargoed", country: "Cuba" },
        },
      ],
      handler: ({ country }) => lookupCountry(country),
    },

    {
      name: "explain_reason_code",
      title: "Expand a reason-for-control code",
      description:
        "Expand a reason-for-control code such as NS, AT or CB into its full " +
        "name. Use this when reading a Control List entry or a chart column and " +
        "the two-letter code is not obvious. Returns the code and the name it " +
        "stands for, or the whole glossary when called with no argument. This " +
        "is a glossary lookup only: it reports what a code means, never whether " +
        "that control applies to anything you are shipping, and it cannot tell " +
        "you whether a licence is required.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "A two-letter reason code, e.g. NS. Omit to list all of them.",
            maxLength: 4,
          },
        },
        required: [],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ok", "unknown_code"], description: "Outcome of the lookup." },
          code: { type: "string", description: "The code, uppercased." },
          name: { type: "string", description: "What the code stands for." },
          codes: { type: "array", description: "Every known code, when none was given.", items: { type: "object" } },
        },
        required: ["status"],
      },
      examples: [
        { args: { code: "NS" }, expect: { status: "ok", code: "NS", name: "National Security" } },
        { args: { code: "zz" }, expect: { status: "unknown_code" } },
        { args: {}, expect: { status: "ok" } },
      ],
      handler: ({ code }) => {
        if (code == null || code === "") {
          return {
            status: "ok",
            codes: Object.entries(REASON_CODES).map(([c, name]) => ({ code: c, name })),
          };
        }
        const key = String(code).toUpperCase().trim();
        const name = REASON_CODES[key];
        return name
          ? { status: "ok", code: key, name }
          : { status: "unknown_code", code: key };
      },
    },
  ],
};
