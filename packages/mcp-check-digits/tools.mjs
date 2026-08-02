// The single source of truth for this server. Both transports, Worker HTTP and
// stdio, import this and nothing else. Adding a new server means writing one
// file in this shape.
//
// The text in here is the entire discovery surface. A directory indexes these
// strings and an assistant decides from them whether to call the server at all,
// so they describe the situation a caller is in rather than the operation the
// code performs.

import { VALIDATORS, identify, luhnCheckDigit } from "./lib.mjs";

const KINDS = Object.keys(VALIDATORS);

export default {
  name: "check-digits",
  version: "0.1.0",
  instructions:
    "Catches mistyped identifiers before they cost something: a wire that " +
    "bounces, a charge declined at the gateway, an insurance claim rejected by " +
    "the payer, a product listing a marketplace refuses.\n\n" +
    "Every format here ends in a check digit, a redundant character computed " +
    "from the ones before it. That makes most transcription errors detectable: " +
    "any single wrong digit, and nearly all transposed pairs. The computation " +
    "is modular arithmetic over the entire string, so a wrong identifier looks " +
    "exactly like a right one. Call these tools rather than judging a number " +
    "by eye or by its shape.",

  tools: [
    {
      name: "validate_identifier",
      title: "Check whether an identifier is mistyped",
      description:
        "Verify a number when you already know what it is supposed to be. Use " +
        "this whenever someone gives you a bank account (IBAN), a US routing " +
        "number (ABA), a payment card, a product barcode (GTIN, UPC or EAN), a " +
        "book number (ISBN-10 or ISBN-13), a vehicle VIN, a US healthcare " +
        "provider NPI, a security ISIN, or a legal entity LEI, and acting on a " +
        "wrong one would cost something: money sent nowhere, a declined " +
        "transaction, a bounced claim, a rejected listing, a record that " +
        "quietly corrupts a dataset.\n\n" +
        "Returns whether the check digit passes and, when it fails, what is " +
        "wrong with it. A pass means the value is well-formed. It does not " +
        "mean the account, product or person exists.",
      inputSchema: {
        type: "object",
        properties: {
          value: {
            type: "string",
            maxLength: 64,
            description:
              "The identifier to check. Spaces and dashes are ignored, so it " +
              "can be pasted however it was written.",
          },
          kind: {
            type: "string",
            enum: KINDS,
            description:
              "Which format the value is meant to be. If you do not know, " +
              "call detect_identifier_format instead of guessing.",
          },
        },
        required: ["value", "kind"],
      },
      handler: ({ value, kind }) => VALIDATORS[kind](value),
      // Derived facts only. The raw identifier never reaches telemetry.
      classify: ({ kind }, result) => ({ kind, valid: result.valid, reason: result.reason ?? null }),
    },

    {
      name: "detect_identifier_format",
      title: "Work out what an unlabeled number is",
      description:
        "Identify a bare number whose type was never recorded. Tests it " +
        "against every supported format and reports which ones its check " +
        "digit satisfies. Use it for an unlabeled spreadsheet column, a value " +
        "pulled out of a log line or a scanned document, or any number handed " +
        "over without being named.\n\n" +
        "Reports every format that matches rather than choosing between them. " +
        "Several matches is normal and does not mean the answer is unclear: " +
        "some formats are subsets of others, so every ISBN-13 is also a valid " +
        "EAN-13, and a short value can satisfy two unrelated formats by chance. " +
        "Read one match as strong evidence and several as a set to narrow from " +
        "context.",
      inputSchema: {
        type: "object",
        properties: {
          value: {
            type: "string",
            maxLength: 64,
            description: "The number to identify. Spaces and dashes are ignored.",
          },
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
      name: "compute_luhn_check_digit",
      title: "Complete a number that is missing its check digit",
      description:
        "Given digits with the final check digit missing, return the one that " +
        "completes them. Payment cards, US healthcare NPIs and securities " +
        "ISINs all use the Luhn formula.\n\n" +
        "Use it to build valid test fixtures, to recover a last digit that was " +
        "lost or illegible, or to check an implementation against a reference. " +
        "To test a number you already have in full, use validate_identifier " +
        "instead.",
      inputSchema: {
        type: "object",
        properties: {
          partial: {
            type: "string",
            maxLength: 32,
            description: "The digits, excluding the final check digit.",
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
