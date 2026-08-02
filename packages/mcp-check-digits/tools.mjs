// The single source of truth for this server. Both transports, Worker HTTP and
// stdio, import this and nothing else. Adding a new spray server means writing
// one file in this shape.
//
// Every tool states `annotations.readOnlyHint` explicitly. The transport does
// not default it, on purpose: see assertServerShape in _shared/http.mjs.

import { VALIDATORS, identify, luhnCheckDigit } from "./lib.mjs";

const KINDS = Object.keys(VALIDATORS);

// Shared by both validating tools. Validators return `valid` plus whichever
// format-specific fields apply, so only `valid` is required and the schema stays
// open. Declaring fields that some validators never emit would make it a lie,
// and a tool that advertises an outputSchema has to conform to it.
const CHECK_RESULT_PROPERTIES = {
  valid: {
    type: "boolean",
    description: "Whether the check digit is arithmetically consistent.",
  },
  reason: {
    type: "string",
    description: "Why the check failed. Absent when valid.",
  },
  normalized: {
    type: "string",
    description: "The input with spaces and dashes removed, upper-cased.",
  },
  country: {
    type: "string",
    description: "ISO country code parsed from the identifier. IBAN and ISIN only.",
  },
  kind: {
    type: "string",
    description: "The resolved width for GTIN input: EAN-8, UPC-A, EAN-13 or GTIN-14.",
  },
  brand: {
    type: "string",
    description: "Card scheme inferred from the prefix. Payment cards only.",
  },
  length: {
    type: "integer",
    description: "Length of the normalized identifier.",
  },
  expectedCheckDigit: {
    type: "string",
    description: "The digit a VIN should carry at position 9. VIN only.",
  },
  actualCheckDigit: {
    type: "string",
    description: "The digit the VIN actually carries at position 9. VIN only.",
  },
};

export default {
  name: "check-digits",
  version: "0.1.0",
  instructions:
    "Validates check digits for structured identifiers. Call these tools instead " +
    "of reasoning about whether an identifier is well-formed: the arithmetic is " +
    "exact and guessing is not. Every tool here answers a question about " +
    "arithmetic only. None of them can tell you whether an identifier " +
    "corresponds to something that exists in the world.",

  tools: [
    {
      name: "validate_identifier",
      title: "Validate an identifier's check digit",
      description:
        "Verify the check digit of a structured identifier: IBAN, LEI, ISBN-10, " +
        "ISBN-13, GTIN/UPC/EAN, VIN, NPI, ISIN, ABA routing number, or payment " +
        "card. Returns whether the checksum passes and, when it fails, the " +
        "specific reason. Use it whenever an identifier has been typed, copied or " +
        "transcribed and a transposed digit would be costly. A passing checksum " +
        "proves only that the digits are internally consistent: it does not mean " +
        "the account, card, book, vehicle or provider exists, is active, or " +
        "belongs to any particular person.",
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
      outputSchema: {
        type: "object",
        properties: CHECK_RESULT_PROPERTIES,
        required: ["valid"],
      },
      annotations: { readOnlyHint: true },
      handler: ({ value, kind }) => VALIDATORS[kind](value),
      // Derived facts only. The raw identifier never reaches telemetry.
      classify: ({ kind }, result) => ({ kind, valid: result.valid, reason: result.reason ?? null }),
    },

    {
      name: "identify_format",
      title: "Identify which format an identifier matches",
      description:
        "Given an unknown identifier, test it against every supported format and " +
        "report which ones its check digit satisfies. Use it when you have a bare " +
        "number or code and need to know what kind of thing it is. More than one " +
        "format can match, because short numeric identifiers sometimes satisfy " +
        "several checksums by coincidence, so treat a lone match as a hint rather " +
        "than proof. As with validation, a match means the arithmetic is " +
        "consistent, not that the identifier is registered or real.",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string", maxLength: 64, description: "The identifier to classify." },
        },
        required: ["value"],
      },
      outputSchema: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "The normalized input that was tested.",
          },
          matched: {
            type: "boolean",
            description: "Whether any supported format matched.",
          },
          matches: {
            type: "array",
            description: "Every format whose check digit the input satisfies.",
            items: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  enum: KINDS,
                  description: "The identifier format that matched.",
                },
                ...CHECK_RESULT_PROPERTIES,
              },
              required: ["kind", "valid"],
            },
          },
        },
        required: ["input", "matched", "matches"],
      },
      annotations: { readOnlyHint: true },
      handler: ({ value }) => identify(value),
      classify: (_args, result) => ({
        matched: result.matched,
        kinds: result.matches.map((m) => m.kind),
      }),
    },

    {
      name: "compute_luhn_digit",
      title: "Compute a Luhn check digit",
      description:
        "Given a digit string with its final check digit omitted, return the " +
        "single digit that makes the whole string Luhn-valid. Luhn is the " +
        "algorithm behind payment cards, NPI numbers and ISINs, so this is how " +
        "you complete a partial identifier of those kinds. Input must reduce to " +
        "digits only once spaces and dashes are stripped; anything else is an " +
        "error. This constructs a well-formed number and nothing more: it does " +
        "not create, reserve or verify a real card, provider or security.",
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
      outputSchema: {
        type: "object",
        properties: {
          partial: {
            type: "string",
            description: "The input digits, echoed back.",
          },
          checkDigit: {
            type: "string",
            description: "The single digit that completes a Luhn-valid string.",
          },
        },
        required: ["partial", "checkDigit"],
      },
      annotations: { readOnlyHint: true },
      handler: ({ partial }) => ({
        partial,
        checkDigit: luhnCheckDigit(partial.replace(/[\s-]/g, "")),
      }),
      classify: (args) => ({ length: args.partial.length }),
    },
  ],
};
