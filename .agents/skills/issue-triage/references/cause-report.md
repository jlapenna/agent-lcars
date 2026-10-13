# Complete cause reports

This is an offline report over an interactive workstream's retained records.
The existing issue ledger and cause evidence remain authoritative. The report
does not create another LCARS runtime store or replace those records.

## Prepare an immutable input set

1. Inventory all root and delegated sources in the requested workstream.
   Read current delegate results and the authoritative issue ledger before
   publishing a total. A root's standalone inventory can omit delegated work.
2. Preserve the exact prior inventory and ledger bytes; record their SHA256s.
   Use retained immutable snapshots for assembly and pin each `sha256` in the
   manifest. Do not overwrite the previous inventory or delete failures.
3. Declare the stable IDs expected for this report window in `expectedIds`.
   Bind that scope to the ledger/evidence, rather than merely copying the IDs
   that happened to survive assembly. Include every cause in that scope,
   including historical failures and causes with closed owning issues. State
   any out-of-window causes explicitly and retain their records separately.
4. Point each source at its complete cause collection. Supply explicit field
   pointers for its actual schema; include every entry, rather than filtering
   unidentified rows. The helper retains the entire original record (including
   failures, acceptance gates and execution/settlement evidence) in the report.
   If a legacy ledger mixes non-cause records into its collection, document
   their classification and preserve them in a reviewed extraction with links
   back to the original snapshot. Do not silently drop ambiguous rows.

Paths are relative to the manifest, except absolute paths. `collection` and
field mappings use JSON pointers (`~0` for `~`, `~1` for `/`). A collection can
be an array or keyed object. `$key` as the ID field explicitly selects a keyed
object's key; array indices are not cause IDs. For example, for records already
using `id`, `issue` and `evidence`:

The following illustrative source bytes each end with one newline:

`blockers.snapshot.json`:

```text
[{"id":"B1","issue":"jlapenna/agent-lcars#1","evidence":["retained/B1.md"]}]
```

`ledger.snapshot.json`:

```text
{"causes":{"B2":{"issue":"jlapenna/agent-lcars#2","bodyFile":"retained/B2.md"}}}
```

Their pinned manifest is:

```json
{
  "expectedIds": ["B1", "B2"],
  "sources": [
    {
      "name": "root",
      "path": "blockers.snapshot.json",
      "sha256": "ee8ccfba2ec2552cdd01997bbc3fa493bc175750a695ad15fb4bffcee4c4e185"
    },
    {
      "name": "delegate",
      "path": "ledger.snapshot.json",
      "sha256": "ab1e222e99c64f21b0e328032e6bc73a784fe66dcc18c204affb59888b4f2978",
      "collection": "/causes",
      "fields": {
        "id": "$key",
        "issue": "/issue",
        "evidence": "/bodyFile"
      }
    }
  ]
}
```

Every source requires its actual 64-digit hexadecimal `sha256`; absent or invalid
pins fail before that source is read. Letter case does not change the pin. For a
real report, compute hashes from the retained exact bytes rather than copying
these illustrative pins. If formatting changes the bytes, recompute the hashes
only after reviewing and freezing that new source snapshot.
The issue field must be a repository-qualified owning identity such as
`jlapenna/agent-lcars#2465`, not a bare number. Convert a retained public issue
URL to that identity only in a reviewed extraction that also preserves its
original URL and source record. An evidence field is a nonempty string or
array of nonempty strings pointing to the measured cause. The helper validates
the presence of pointers; the operator must separately read/qualify their
contents and disclose unavailable evidence. A complete inventory is not proof
that a source fix, deployment or provider execution was qualified.

## Resolve aliases without guessing

An alias may resolve only a descriptive object key whose mapped ID is absent
or that exact same key. Different explicit ID values, array positions, numeric keys and
malformed cause-namespace spellings such as `B-1`, `b1` or `B 1` remain
unresolved. A descriptive key needs an explicit alias tied to its retained
body-file identity. Add an entry in `aliases` with `source` (source name), `key` (exact
collection entry key), `id` (stable cause ID), `issue` (qualified owning issue),
`bodyFile` (exact pointer already present in the row's evidence), and `basis`
(the retained receipt that establishes this mapping). The operator must read
that basis first. The helper requires agreement with the row's owning issue
and body-file pointer and rejects conflicting or unused aliases.

Repeating a record or the same alias does not add another cause. Different
causes can share one owning issue, so unique issue totals can differ from
cause totals. One cause with conflicting owning issues is unresolved; the
operator must adjudicate it from evidence. Unknown/malformed IDs, missing
evidence pointers, unbound aliases and scope gaps keep the report incomplete.
No heuristic manufactures a missing identity.

## Assemble and publish

```bash
node .agents/skills/issue-triage/scripts/reconcile-causes.mjs \
  /private/workstream/cause-report-manifest.json \
  > /private/workstream/cause-report-next.json
```

Check the actual exit status before proceeding. Exit 1 withholds `totals` and
retains diagnostic subtotals under `observed`; those are never a complete
workstream count. Inspect `unresolved`, `aliasErrors`, `missingIds` and
`unexpectedIds`. Missing/unreadable sources, malformed mappings, invalid JSON
or an absent, invalid or changed snapshot pin also fail with no totals. Repair the smallest
authoritative source or explicit alias from evidence, then assemble again.
Retain each failed report alongside the successful one.

For an exit-0 report, publish the report path/hash, every input path/hash, the
report scope and `totals.causes` plus `totals.owningIssues`. Link the retained
records and remaining acceptance gates. Re-run this assembly for the next
report after reconciling new root/delegate records. A previous successful
report cannot qualify a changed source set or subsequent workstream count.

Query live public issue states separately, with repository-qualified identities
and a query timestamp, for closed-issue counts. Source review, merged source,
runtime qualification and actual provider execution each need their own
receipts. Settling or cancelling queued intent because source is already
satisfied supplies no evidence that the selected provider ran.

## Historical acceptance for #2465

Run the assembler on the **retained actual files** for B1–B182: the preserved
root snapshot contains B1–B66 and B167–B182 (82); the authoritative ledger adds
B67–B166 (100). Replays must leave the complete total at 182 unique IDs. Use
the retained body-file identities to bind the four descriptive ledger keys:
B67 → `jlapenna/agent-lcars#2299`, B68 → `jlapenna/agent-lcars#2301`,
B69 → `jlapenna/agent-lcars#2302`, B70 → `jlapenna/agent-lcars#2303`.
The issue numbers alone do not establish those aliases.

The original snapshot SHA256 recorded in the issue is
`4181614451972288f0faa17a27f4dc347b3f73470b1d0b81f8f0504a0fe9d1bd`.
The private consolidation receipt is
`/tmp/lcars-product-review-01a11f2d/root-blocker-inventory-consolidation-receipt.json`.
Exclude B183 (this workflow defect) from the historical window explicitly.
Qualify a subsequent complete report over the then-current scope using the
same workflow; preserve both receipts.

The required `Verify` contract-test lane exercises the actual assembler and
CLI against a **synthetic regression fixture** matching the reported 82+100
shape, alias cases, duplicates and unresolved data. That proves the algorithm
and refusal contract, not access to the private files, their exact body-file
IDs, or a subsequent actual monitor report. Keep those acceptance gates open
until the operator with the retained artifacts supplies the real receipts.
