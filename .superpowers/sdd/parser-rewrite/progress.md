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
