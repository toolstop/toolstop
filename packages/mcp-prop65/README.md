# @toolstop/prop65

Is a chemical on California's Proposition 65 list, and does it need a warning?

Embeds the OEHHA list published under Title 27 CCR section 27001, **31-Jul-26**
edition: 1,021 entries, of which 994 are currently listed and 27 were listed and
later removed. No upstream call, no key, no account.

## Install

```jsonc
// Claude Desktop, Cursor, VS Code
{ "mcpServers": { "prop65": { "url": "https://prop65.toolstop.dev" } } }
```

```bash
npx @toolstop/prop65     # stdio, nothing leaves your machine
```

## Tools

| Tool | Answers |
|---|---|
| `check_prop65` | Is this CAS number or chemical listed, with endpoint, safe-harbour level and delisting |
| `search_prop65` | Which listed chemicals contain this name fragment |
| `list_recent_listings` | What was added since a given year, which starts a 12-month clock |
| `describe_prop65_list` | Size and edition of the embedded list, and what the mechanism codes mean |

```
check_prop65 { query: "71-43-2" }
  -> listed: true, Benzene, cancer + developmental/male,
     safe harbour 6.4 (oral); 13 (inhalation), listed 1987-02-27

check_prop65 { query: "56-75-7" }
  -> listed: false, delistedOnly: true, Chloramphenicol,
     "Delisted January 4, 2013"
```

## What this does not do

**A `not_found` result is not a clearance.** Every answer, hit or miss, carries a
`notCovered` array, because this is the result most likely to be over-read:

- The list is revised at least yearly. Anything added after this edition is
  absent.
- Chemicals appear under names and under group listings with no CAS number, so an
  exact-match miss is not proof of absence.
- **Prop 65 turns on exposure, not presence.** A listed chemical below its safe
  harbour level may need no warning; an unlisted one may still be regulated
  elsewhere.
- This is the California list only. It says nothing about REACH, RoHS or TSCA.

**Delisted is not the same as never listed**, and both are reported. A removed
entry returns `listed: false` with `delistedOnly: true` and the removal date,
rather than vanishing.

**Ambiguous names are not guessed.** "chromium" returns candidates and asks you to
choose, or to query by CAS number.

**Safe-harbour levels are a regulatory threshold, not a safety judgement.** This
is not legal advice, and OEHHA is the authority if the two disagree.

## Refreshing the data, and the two traps

`data.mjs` is generated from OEHHA's published spreadsheet:

```bash
curl -L -o p65.xlsx https://oehha.ca.gov/sites/default/files/media/downloads/proposition-65/p65chemicalslist.xlsx
```

**Use the xlsx, never the CSV.** OEHHA marks removed chemicals with *strikeout
formatting*, which the CSV export silently drops. Parsing the CSV reports all 27
delisted chemicals as currently listed, which is a false positive on the exact
question this server answers. The generator reads `xl/styles.xml`, finds the font
ids carrying `<strike/>`, and flags any row whose chemical cell uses one.

**Convert the dates.** The `Date Listed` column is Excel serial numbers, not
dates. Left unconverted they parse as plausible-looking garbage: a naive
"listed since 2024" query returned 802 results instead of 8. Serials are days
since 1899-12-30.

Two smaller shapes worth keeping: some entries carry several CAS numbers
separated by semicolons and must be findable by each, and some carry `---` or
nothing where a group listing has no single CAS number.

## Privacy

**Nothing you submit is recorded.** Telemetry captures the *shape* of a call, not
its values: field names with types and lengths, never a chemical name or CAS
number.

**What is recorded.** One row per request, retained 90 days:

| | |
|---|---|
| The call | Server name and version, MCP method, tool name, outcome, error *class* (never the message), duration, result size |
| The client | Client name, version and protocol version as your software reports them, plus a truncated user agent |
| Coarse location | Country and Cloudflare data centre. Never a precise location |
| Argument *shape* | Field names with types and lengths, for example `str:7`. Never a value |
| A session id | A hash of your user agent, the date, this server's name, and the **network block** your request came from, truncated to a /24 or /48 first. It counts distinct sessions in a day, does not link across days, and cannot distinguish two callers behind one network |

**Running over stdio, none of this happens.** The server runs on your machine and
deliberately does not phone home.

## License

MIT for the code. The underlying list is published by the California Office of
Environmental Health Hazard Assessment as Title 27 CCR section 27001.
