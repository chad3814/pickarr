/**
 * The DOM id of a group's card on the Picks tab.
 *
 * `MediaCard` carries this id on the card it renders, and a fragment landing
 * on `/picks#group-N` — from a bookmark or a link written outside this app —
 * has to match it exactly to find its card. So there is one function, and
 * anything building or matching that id imports it rather than templating it
 * again.
 *
 * Prefixed rather than the bare number because a fragment has to be a valid
 * id, and `#1` is not.
 */
export function groupAnchor(groupId: number): string {
  return `group-${groupId}`;
}
