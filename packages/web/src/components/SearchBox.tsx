interface Props {
  /**
   * What this box searches, as its accessible name — "Search picks", not
   * "Search". Three routes render one of these and each carries the same
   * `placeholder="Search"`, which is the only name the control had before: a
   * screen reader on Downloads and one on Picks announced the identical thing,
   * and neither said what the term would be matched against.
   */
  label: string;
  value: string;
  onChange(value: string): void;
}

/**
 * The one search input, shared by Browse, Picks and Downloads.
 *
 * What each route does with the term differs — Browse sends it to
 * `/api/browse?q=` and starts its pagination over, Picks and Downloads filter
 * the list they already hold — so the term is owned by the route and this
 * remembers nothing. Extracted when the second and third copies of it were
 * about to be written: the markup is small, but the `type`/`className`/
 * placeholder/label agreement between three tabs is the part worth having in
 * one place.
 */
export function SearchBox({ label, value, onChange }: Props) {
  return (
    <input
      className="search"
      type="search"
      aria-label={label}
      placeholder="Search"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
