/**
 * The DOM id of a group's card on the Picks tab.
 *
 * Two places have to agree on this string — the card that carries the id and
 * the Downloads row that links to it — and a link built from a second template
 * that drifts from the first is a dead link with nothing to fail against. So
 * there is one function and both import it.
 *
 * Prefixed rather than the bare number because a fragment has to be a valid
 * id, and `#1` is not.
 */
export function groupAnchor(groupId: number): string {
  return `group-${groupId}`;
}

/** The href a Downloads row uses to reach that card. */
export function groupAnchorHref(groupId: number): string {
  return `/picks#${groupAnchor(groupId)}`;
}
