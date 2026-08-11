// The single source of truth for this server. Both transports import this and
// nothing else.
//
// The governing rule: a false "not listed" and a false "listed" are both
// expensive, in opposite directions. A missed listing is a warning that should
// have been on the product; a wrong hit is a warning that should not have been.
// So every answer distinguishes "delisted" from "never listed", and a miss says
// plainly that it is not a clearance.

import { checkChemical, searchChemicals, listedSince, stats, MECHANISMS, EDITION } from "./lib.mjs";

const STATUSES = ["ok", "not_found", "ambiguous", "invalid_query"];

const STATUS_PROPERTY = {
  type: "string",
  enum: STATUSES,
  description:
    "Outcome of the lookup. `not_found` is not a clearance. `ambiguous` means " +
    "the name matched several entries and you should pick one or use a CAS number.",
};

export default {
  name: "prop65",
  version: "0.1.0",
  instructions:
    "Answers whether a chemical is on California's Proposition 65 list, the " +
    "list of substances requiring a consumer warning in California. Data is " +
    "the OEHHA list published under Title 27 CCR section 27001, " + EDITION +
    " edition, embedded in the server.\n\n" +
    "Call these tools instead of recalling the list from memory. It carries " +
    "about a thousand entries, is revised at least yearly, and a wrong answer " +
    "is expensive in both directions: a missed listing is a missing warning " +
    "and a private-enforcement notice, while a spurious one is a warning that " +
    "should not be there.\n\n" +
    "**A `not_found` result is not a clearance.** Prop 65 turns on exposure " +
    "rather than presence, chemicals appear under names and group listings " +
    "that an exact match will miss, and the list changes. Every answer carries " +
    "a `notCovered` array saying what it does not establish; pass that on " +
    "rather than reporting a bare yes or no.\n\n" +
    "**Delisted chemicals are reported, not hidden.** Twenty-seven entries " +
    "were listed and later removed. They return `listed: false` with " +
    "`delistedOnly: true` and the removal date, because 'was never listed' and " +
    "'was removed in 2013' are different facts.\n\n" +
    "Choosing between the tools: with a CAS number or an exact chemical name, " +
    "call check_prop65, which is the main lookup. Use search_prop65 when you " +
    "only have part of a name. Use list_recent_listings to find chemicals added " +
    "recently, which matters because a warning is generally required twelve " +
    "months after listing.\n\n" +
    "This is not legal advice, and safe-harbour levels are the threshold below " +
    "which no warning is required, not a safety judgement. If a lookup " +
    "disagrees with OEHHA, OEHHA is the authority; report it at " +
    "https://github.com/toolstop/toolstop/issues.",

  tools: [
    {
      name: "check_prop65",
      title: "Is this chemical on the Proposition 65 list",
      description:
        "Look up a chemical by CAS number or name and report whether it is on " +
        "California's Proposition 65 list. Use this when deciding whether a " +
        "product sold into California needs a warning label. Returns every " +
        "matching entry with the toxicity endpoint, the listing mechanism, the " +
        "date listed and the safe-harbour level where one has been adopted, " +
        "plus whether the entry has since been delisted. A `not_found` result " +
        "does not mean the chemical is safe or unregulated: it means this " +
        "edition of this one list has no entry under that name or number.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "A CAS number such as 71-43-2, or a chemical name such as Benzene.",
            maxLength: 200,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          status: STATUS_PROPERTY,
          listed: {
            type: "boolean",
            description: "Whether an active (not delisted) entry exists. Present when status is `ok`.",
          },
          delistedOnly: {
            type: "boolean",
            description: "True when every matching entry was listed and later removed.",
          },
          entries: {
            type: "array",
            description: "Each matching entry, including delisted ones, with its endpoint and safe-harbour level.",
            items: { type: "object" },
          },
          candidates: {
            type: "array",
            description: "Possible chemicals, when the name matched several entries.",
            items: { type: "object" },
          },
          notCovered: {
            type: "array",
            description: "What this answer does not establish. Present on both hits and misses.",
            items: { type: "string" },
          },
          edition: { type: "string", description: "The edition of the list this answer came from." },
        },
        required: ["status"],
      },
      examples: [
        { args: { query: "71-43-2" }, expect: { status: "ok", listed: true } },
        { args: { query: "Acetamide" }, expect: { status: "ok", listed: true } },
        { args: { query: "56-75-7" }, expect: { status: "ok", listed: false, delistedOnly: true } },
        { args: { query: "dihydrogen monoxide" }, expect: { status: "not_found" } },
      ],
      handler: ({ query }) => checkChemical(query),
    },

    {
      name: "search_prop65",
      title: "Find listed chemicals by partial name",
      description:
        "Search the Proposition 65 list for chemicals whose name contains a " +
        "fragment. Use this when you do not have an exact name or a CAS " +
        "number, or to survey a family of related substances. Returns matching " +
        "chemicals with their CAS numbers, toxicity endpoints, listing dates " +
        "and delisted flags, capped at a limit with `truncated` set when there " +
        "were more. It searches names only, so it will not find a chemical " +
        "listed under a synonym you did not search for, and a result here is " +
        "not a determination that a warning is required.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          term: {
            type: "string",
            description: "A fragment of a chemical name, such as 'benz' or 'chromium'.",
            maxLength: 120,
          },
          limit: {
            type: "number",
            description: "Maximum results to return. Defaults to 25.",
          },
        },
        required: ["term"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          status: STATUS_PROPERTY,
          count: { type: "number", description: "How many entries matched in total." },
          truncated: { type: "boolean", description: "Whether more matched than were returned." },
          results: { type: "array", description: "The matching chemicals.", items: { type: "object" } },
          edition: { type: "string", description: "The edition of the list this answer came from." },
        },
        required: ["status"],
      },
      examples: [
        { args: { term: "chromium" }, expect: { status: "ok" } },
        { args: { term: "benzene", limit: 5 }, expect: { status: "ok", truncated: true } },
      ],
      handler: ({ term, limit }) => searchChemicals(term, limit ?? 25),
    },

    {
      name: "list_recent_listings",
      title: "Chemicals added to the list since a year",
      description:
        "List the chemicals added to Proposition 65 on or after a given year. " +
        "Use this to find recent additions, which matters because a warning is " +
        "generally required twelve months after a chemical is listed, so a new " +
        "entry starts a compliance clock. Returns active listings only, newest " +
        "first, with their dates, and reports how many entries carry no " +
        "parseable date and are therefore missing from the answer. It does not " +
        "tell you whether any particular product is affected.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          since: {
            type: "number",
            description: "Four-digit year, from 1986 onwards. Prop 65 listings begin in 1987.",
          },
        },
        required: ["since"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          status: STATUS_PROPERTY,
          count: { type: "number", description: "How many active chemicals were listed on or after that year." },
          results: { type: "array", description: "The chemicals, newest first.", items: { type: "object" } },
          undatedEntries: {
            type: "number",
            description: "Active entries with no parseable listing date, absent from this answer.",
          },
          edition: { type: "string", description: "The edition of the list this answer came from." },
        },
        required: ["status"],
      },
      examples: [
        { args: { since: 2025 }, expect: { status: "ok" } },
        { args: { since: 1800 }, expect: { status: "invalid_query" } },
      ],
      handler: ({ since }) => listedSince(since),
    },

    {
      name: "describe_prop65_list",
      title: "What this list is and what it covers",
      description:
        "Report the size and edition of the embedded Proposition 65 list, and " +
        "what the listing-mechanism codes mean. Use this to check how current " +
        "the data is before relying on a lookup, or to interpret the `AB`, " +
        "`SQE`, `FR` and `LC` codes on an entry. Returns counts of total, " +
        "active and delisted entries, how many carry a CAS number, and the " +
        "edition date. It reports on the data only and cannot tell you whether " +
        "any product requires a warning.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ok"], description: "Always ok." },
          total: { type: "number", description: "Entries in the embedded list, including delisted ones." },
          active: { type: "number", description: "Entries currently listed." },
          delisted: { type: "number", description: "Entries listed and later removed." },
          withCas: { type: "number", description: "Entries carrying at least one CAS number." },
          edition: { type: "string", description: "Edition date of the OEHHA list." },
          mechanisms: { type: "object", description: "Listing-mechanism codes and their meanings." },
        },
        required: ["status"],
      },
      examples: [{ args: {}, expect: { status: "ok" } }],
      handler: () => ({ status: "ok", ...stats(), mechanisms: MECHANISMS }),
    },
  ],
};
