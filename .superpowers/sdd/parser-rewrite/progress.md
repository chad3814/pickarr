# SDD ledger — parser rewrite (date-as-boundary)

Follow-on from the Pickarr MVP (42 commits, complete). Human supplied two
references: Whisparr's Parser.cs (GPL-3.0, C#) and ThePornDatabase/namer
(Python, license unstated, depends on ThePornDB API).

LICENSING CONSTRAINT: our repo is MIT. Learn the SHAPES and the boundary RULE
(facts about the domain) — do NOT copy regex tables or code from either source.

Baseline measured before starting: our parser handles 2/10 realistic shapes.
  parses : Site.YY.MM.DD.Performers.XXX.quality-GROUP
  parses WRONGLY: 'www.site.com - Brazzers.23.04.15...' -> identity key
    'www-site-com-brazzers:...' — the prefix is absorbed into the site slug, so
    the same scene with and without the prefix SPLITS into two groups. Worse than
    a refusal. Not previously recorded.
  refuses: dot-attached group (.PRT), bracketed site + DD-MM-YYYY, bracketed site
    + ISO date last, studio-performers-title with written month in parens,
    concatenated YYYYMMDD, concatenated YYMMDD, trailing file extension, VR tag.

KEY INSIGHT from Whisparr, and the reason for the rewrite: use the DATE as the
identity/encode boundary, not a marker token. Everything before the date is the
site; everything after is title/performers; quality is parsed separately. Our
XXX-marker boundary cost three fix rounds during the MVP precisely because XXX
appears in titles AND in release group names. The date does not have that problem
and is effectively always present in this domain.

FIX ROUND 1 — commit a87280d (signed). 233 -> 239 tests, corpus 62 -> 75 rows,
quality now pinned per row.
Controller verified all five:
  C1 five .com studios -> five distinct keys, studio kept as the site; a real
     www. prefix is still stripped.
  C2 join is now '--'; both re-split pairs distinct; listing ORDER still does not
     split (vixen:2023-07-19:kylie--page-turner).
  I3 stamped dotted name keeps quality: 1080p 1,080,041,000 vs 2160p 2,160,044,000.
  I4 group-tag guards now shared: -Part1/-Part2, -CD1/-CD2, -Uncut/-Directors,
     -French/-German all REFUSE (null) in both the hyphen and dot branches, every
     casing. Refusal is the safe direction; they land in the parse_error worklist.
  I5 quality pinned per corpus row; 11 of 23 corpus tests fail against 3c0d43b.
  Bonus: pinning quality exposed 2160p60 matching no resolution and scoring below
  480p in its own group. Fixed.
CONTROLLER TEST ERROR, corrected: I first reported I4 as FAIL because my assertion
  was `k(x) !== k(y)` and both are null, so null!==null was false. Both-null is a
  REFUSAL, not a merge. Check for refusal explicitly when the safe outcome is null.
