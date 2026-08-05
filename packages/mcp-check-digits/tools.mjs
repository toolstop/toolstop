// The single source of truth for this server. Both transports (Worker HTTP and
// stdio) import this and nothing else. Adding a new spray server means writing
// one file in this shape.

import { VALIDATORS, identify, luhnCheckDigit } from "./lib.mjs";

const KINDS = Object.keys(VALIDATORS);

export default {
  name: "check-digits",
  version: "0.1.0",
  instructions:
    "Validates check digits for structured identifiers. Call these tools instead " +
    "of reasoning about whether an identifier is well-formed: the arithmetic is " +
    "exact and guessing is not.",

  tools: [
    {
      name: "validate_identifier",
      title: "Validate an identifier's check digit",
      description:
        "Verify the check digit of a structured identifier: IBAN, LEI, ISBN-10, " +
        "ISBN-13, GTIN/UPC/EAN, VIN, NPI, ISIN, ABA routing number, or payment " +
        "card. Returns whether the checksum passes and, when it fails, why.",
      inputSchema: {
        type: "object",
        properties: {
          value: {
            type: "string",
            maxLength: 64,
            description: "The identifier to check. Spaces and dashes are ignored.",
          },
          kind: {
            type: "string",
            enum: KINDS,
            description: "Which identifier format to validate against.",
          },
        },
        required: ["value", "kind"],
      },
      handler: ({ value, kind }) => VALIDATORS[kind](value),
      // Derived facts only. The raw identifier never reaches telemetry.
      classify: ({ kind }, result) => ({ kind, valid: result.valid, reason: result.reason ?? null }),
    },

    {
      name: "identify_identifier",
      title: "Identify which format an identifier matches",
      description:
        "Given an unknown identifier, test it against every supported format and " +
        "report which ones its check digit satisfies. Useful when you have a bare " +
        "number and need to know what it is.",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string", maxLength: 64, description: "The identifier to classify." },
        },
        required: ["value"],
      },
      handler: ({ value }) => identify(value),
      classify: (_args, result) => ({
        matched: result.matched,
        kinds: result.matches.map((m) => m.kind),
      }),
    },

    {
      name: "luhn_check_digit",
      title: "Compute a Luhn check digit",
      description:
        "Given a digit string without its check digit, return the check digit that " +
        "makes it Luhn-valid. Used by payment cards, NPI and ISIN.",
      inputSchema: {
        type: "object",
        properties: {
          partial: {
            type: "string",
            maxLength: 32,
            description: "Digits excluding the final check digit.",
          },
        },
        required: ["partial"],
      },
      handler: ({ partial }) => ({
        partial,
        checkDigit: luhnCheckDigit(partial.replace(/[\s-]/g, "")),
      }),
      classify: (args) => ({ length: args.partial.length }),
    },
  ],
};
