// The single source of truth for this server. Both transports (Worker HTTP and
// stdio) import this and nothing else. Adding a new spray server means writing
// one file in this shape.
//
// Every tool states `annotations.readOnlyHint` explicitly. The transport does
// not default it, on purpose: see assertServerShape in _shared/http.mjs.
//
// Every tool also states `examples`, which is what makes it testable. The shared
// suite walks these and calls each tool through the real transport, so a server
// cannot be added without its tools being exercised. `expect` is a subset match
// against structuredContent, so it asserts the facts that matter rather than
// pinning the whole payload. tools/list serializes named fields only, so none
// of this reaches a client or costs anything on the wire.
//
// Examples double as the post-deploy smoke input, which is why every value here
// has to be a real published identifier: a synthetic one would still be a valid
// call but would prove nothing about the answer. Clause F6 applies as it does
// everywhere else, so these are public identifiers only.

import { VALIDATORS, identify, luhnCheckDigit } from "./lib.mjs";

const KINDS = Object.keys(VALIDATORS);

// Validators return `valid` plus whichever format-specific fields apply, so only
// `valid` is required and the schema stays open. Declaring fields that some
// validators never emit would make it a lie, and a tool that advertises an
// outputSchema has to conform to it.
//
// identify_format deliberately does not repeat this block. Its matches carry the
// same fields, but spelling them out a second time cost ~1.1k characters of
// every tools/list response to tell the model something it had already read.
const CHECK_RESULT_PROPERTIES = {
  valid: {
    type: "boolean",
    description: "Whether the check digit is arithmetically consistent.",
  },
  code: {
    type: "string",
    enum: ["format", "length", "checksum"],
    description: "Bounded reason the check failed. Absent when valid.",
  },
  reason: {
    type: "string",
    description: "Human-readable detail on the failure. Absent when valid.",
  },
  normalized: {
    type: "string",
    description: "The input with spaces and dashes removed, upper-cased.",
  },
  country: {
    type: "string",
    description: "ISO country code parsed from the identifier. ISIN only.",
  },
  width: {
    type: "string",
    enum: ["EAN-8", "UPC-A", "EAN-13", "GTIN-14"],
    description: "The resolved width of a GTIN. GTIN input only.",
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
  version: "0.2.0",
  instructions:
    "Catches mistyped barcodes, VINs, ISBNs and other public structured " +
    "identifiers before a bad one causes a rejected listing, a bounced claim " +
    "or a corrupted record.\n\n" +
    "This server deliberately does not handle bank accounts, IBANs, routing " +
    "numbers or payment cards. Do not send them here. Validate those locally " +
    "instead, with a library, so the value never leaves the machine that " +
    "already has it.\n\n" +
    "Call these tools instead of reasoning about whether an identifier is " +
    "well-formed: the arithmetic is exact and guessing is not. Each check digit " +
    "is computed over the whole string, so a value with one wrong or " +
    "transposed character looks exactly like a correct one. There is nothing to " +
    "see by eye. Every tool here answers a question about arithmetic only. None " +
    "of them can tell you whether an identifier corresponds to something that " +
    "exists in the world.\n\n" +
    "Choosing between them: if you already know what the identifier is meant to " +
    "be, call validate_identifier with that `kind`. If you do not know, call " +
    "identify_format first and pass a returned `kind` back to " +
    "validate_identifier. Do not guess a `kind`, because validate_identifier " +
    "reports a correct identifier of one format as invalid when it is checked " +
    "against another, and that reads like a bad identifier rather than a bad " +
    "guess.",

  tools: [
    {
      name: "validate_identifier",
      title: "Check whether an identifier is mistyped",
      description:
        "Verify a number when you already know what it is supposed to be. Use " +
        "this whenever someone gives you a product barcode (GTIN, UPC or EAN), " +
        "a book number (ISBN-10 or ISBN-13), a vehicle VIN, a US healthcare " +
        "provider NPI, a security ISIN, or a legal entity LEI, and acting on a " +
        "wrong one would cost something: a bounced claim, a rejected listing, " +
        "a record that quietly corrupts a dataset.\n\n" +
        "Every supported format is a public identifier. Bank accounts, IBANs, " +
        "routing numbers and payment cards are not supported and must not be " +
        "sent.\n\n" +
        "Returns whether the checksum passes and, when it fails, the specific " +
        "reason. If you do not already know the format, call identify_format " +
        "first rather than guessing a `kind`, since a valid identifier checked " +
        "against the wrong format comes back invalid. A passing checksum proves " +
        "only that the digits are internally consistent: it does not mean the " +
        "book, product, vehicle or provider exists, is active, or belongs " +
        "to any particular person.",
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
      // Apple's LEI, and a real VIN with one digit changed. Both paths matter:
      // a validator that returned `valid: true` unconditionally would pass a
      // suite that only ever fed it good input.
      examples: [
        {
          args: { value: "HWUPKR0MPOU8FGXBT394", kind: "lei" },
          expect: { valid: true, normalized: "HWUPKR0MPOU8FGXBT394" },
        },
        {
          args: { value: "1HGCM82634A004352", kind: "vin" },
          expect: { valid: false, code: "checksum" },
        },
      ],
      handler: ({ value, kind }) => VALIDATORS[kind](value),
      // Derived facts only. The raw identifier never reaches telemetry.
      //
      // `code` and not `reason`: the prose interpolates the input in places (an
      // IBAN's country code, a VIN's expected check digit), so forwarding it
      // would put substrings of a real identifier into Analytics Engine. The
      // bounded code is also the better telemetry, since it groups in SQL and
      // survives someone rewording a message.
      classify: ({ kind }, result) => ({ kind, valid: result.valid, code: result.code ?? null }),
    },

    {
      name: "identify_format",
      title: "Work out what an unlabeled number is",
      description:
        "Identify a bare number whose type was never recorded. Tests it against " +
        "every supported format and reports which ones its check digit " +
        "satisfies. Use it for an unlabeled spreadsheet column, a value pulled " +
        "out of a log line or a scanned document, or any number handed over " +
        "without being named.\n\n" +
        "Reports every format that matches rather than choosing between them. " +
        "Several matches is normal and does not mean the answer is unclear: " +
        "some formats are subsets of others, so every ISBN-13 is also a valid " +
        "EAN-13, and a short value can satisfy two unrelated formats by chance. " +
        "Read one match as strong evidence and several as a set to narrow from " +
        "context. As with validation, a match means the arithmetic is " +
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
            description:
              "Every format whose check digit the input satisfies, in registry " +
              "order. Each entry carries `kind` plus the same format-specific " +
              "fields validate_identifier returns for that format, such as " +
              "`country` for an ISIN or `width` for a GTIN. Only satisfied " +
              "formats are listed, so no entry carries `code` or `reason`.",
            items: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  enum: KINDS,
                  description:
                    "The identifier format that matched. Pass this straight " +
                    "back to validate_identifier as its `kind`.",
                },
                valid: {
                  type: "boolean",
                  description: "Always true. Formats that failed are omitted, not listed as false.",
                },
              },
              required: ["kind", "valid"],
            },
          },
        },
        required: ["input", "matched", "matches"],
      },
      annotations: { readOnlyHint: true },
      // A real EAN-13, and a string that is not an identifier at all. `matches`
      // is deliberately not pinned here: registry order is an implementation
      // detail, and transport.test.mjs already asserts which kinds come back.
      examples: [
        { args: { value: "4006381333931" }, expect: { matched: true } },
        { args: { value: "hello world" }, expect: { matched: false } },
      ],
      handler: ({ value }) => identify(value),
      classify: (_args, result) => ({
        matched: result.matched,
        kinds: result.matches.map((m) => m.kind),
      }),
    },

    {
      name: "compute_luhn_digit",
      title: "Complete a number that is missing its check digit",
      description:
        "Given digits with the final check digit omitted, return the one that " +
        "completes them. US healthcare NPIs and securities ISINs use the Luhn " +
        "formula.\n\n" +
        "Use it to build valid test fixtures, to recover a last digit that was " +
        "lost or illegible, or to check an implementation against a reference. " +
        "To test a number you already have in full, use validate_identifier " +
        "instead. Input must reduce to digits only once spaces and dashes are " +
        "stripped; anything else is an error. Payment cards also use Luhn, and " +
        "are deliberately out of scope here: do not pass card digits, partial " +
        "or complete. This constructs a well-formed number and nothing more: " +
        "it does not create, reserve or verify a real provider or security.",
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
      // The NPPES prefix plus a nine-digit NPI body, which is the documented
      // worked example for this algorithm. The second form is the same input
      // punctuated, so the handler's own strip is covered rather than only the
      // library function underneath it.
      examples: [
        { args: { partial: "80840123456789" }, expect: { checkDigit: "3" } },
        { args: { partial: "808-401-234-567-89" }, expect: { checkDigit: "3" } },
      ],
      handler: ({ partial }) => ({
        partial,
        checkDigit: luhnCheckDigit(partial.replace(/[\s-]/g, "")),
      }),
      classify: (args) => ({ length: args.partial.length }),
    },
  ],
};
