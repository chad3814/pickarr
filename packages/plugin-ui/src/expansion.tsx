/**
 * The expander every browse card composes, in the two pieces a card needs
 * separately: the state and the announcement.
 *
 * **Why this is here and not in each plugin (issue #106).** The design spec
 * §3 argues `@pickarr/plugin-ui` exists because "three plugins owning a card
 * body means three release lists, three pick buttons and three sets of
 * accessibility decisions [...] that hazard is paid once per component, so
 * the components are shared". The first version shipped sharing
 * {@link ReleaseList} and not the expander, so `aria-expanded` -- the one
 * obligation a plugin can get wrong entirely on its own -- was the one thing
 * written three times. `CLAUDE.md`'s longest hazard is precisely that
 * shape: `role` and `aria-*` satisfying every query while nothing is usable.
 *
 * **Two pieces rather than one card component.** A single
 * `<ExpandingCard>` rendering the whole body would leave a plugin no way to
 * add content of its own -- and spec §7.2 already names what is coming
 * (`movie`'s `runtimeMinutes` and `tagline`, `xxx`'s `siteName`). Splitting
 * the hook from the heading keeps each card owning its own body gate, which
 * is where that content lands, without inventing a `children` or
 * render-prop API before anything needs one.
 *
 * What stays duplicated, deliberately: one `{expanded && …}` line per card.
 * That is body composition, not an accessibility obligation, and it is the
 * line §7.2's content will grow out of.
 *
 * **There is a fourth consumer now, and it is not a plugin.**
 * `packages/web`'s own `library/Unmatched.tsx` composes these two for a
 * release no lookup matched -- a row with no `media_item` and therefore no
 * plugin card at all, which still has to look like the rest of the
 * application rather than like a different one. So the argument above is
 * narrower than the reason this package earns its place: sharing the
 * expander stops a *fourth* `aria-expanded` being written whether the
 * writer is a plugin or web itself, and the `<small>` and `<h2>` this file
 * emits are the elements `web/src/styles/library.css` selects on both
 * screens. `@pickarr/plugin-ui` is the shared card seam; the plugin
 * boundary is the reason it exists, not the limit of what may use it.
 *
 * `test/expansion.test.tsx`'s scan is still scoped to `packages/plugin-*`
 * and is unchanged by this: web's compliance is not something a plugin
 * could break, and `packages/web/test/library/Unmatched.test.tsx` asserts
 * the composed heading directly.
 *
 * That consumer also exercises a case no plugin does: it passes a reporter
 * that does nothing, because it gathers nothing and so has nothing to
 * start or stop. See {@link useExpansion} on why closing is reported at
 * all, and `Unmatched.tsx`'s `REPORTS_NOTHING` on why a no-op there is a
 * hoisted constant rather than an inline arrow.
 */
import { useCallback, useState, type ReactElement } from 'react';

export interface Expansion {
  /** Whether the card is open. A card gates its own body on this. */
  readonly expanded: boolean;
  /** Flips the state and reports the new value. Hand straight to {@link CardHeading}. */
  readonly toggle: () => void;
}

/**
 * A card's expanded state, reporting **every** transition to `onExpandedChange`.
 *
 * **Closing is reported too, and that is the whole reason this is a hook
 * rather than an `onClick` in each card.** Web tears a closed card's
 * subscriptions down when it hears about the close; an earlier version of
 * this seam had only an `onExpand`, and `usePluginRows`' sibling hook left
 * **72 subscriptions live for 24 cards** nobody had left open, costing 24
 * IndexedDB transactions per download insert with nothing on screen. A
 * plugin that wrote its own handler and forgot the closing call would
 * reinstate exactly that, for itself alone, invisibly to every test of the
 * other cards.
 *
 * `useCallback` because `toggle` is handed to a `<button>`'s `onClick` in
 * four cards now; a fresh identity per render is a new prop per render for
 * every card on a paged list. **The memo is only as good as the callback
 * handed in**, which is a real constraint on a caller rather than a note:
 * a card that passes a freshly built arrow gets a freshly built `toggle`
 * every render and none of this. The three plugin cards pass the
 * `onExpandedChange` prop they were given, and web's unmatched screen
 * passes a module-level constant for the same reason.
 */
export function useExpansion(onExpandedChange: (expanded: boolean) => void): Expansion {
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => {
    setExpanded((current) => {
      const next = !current;
      onExpandedChange(next);
      return next;
    });
  }, [onExpandedChange]);

  return { expanded, toggle };
}

export interface CardHeadingProps {
  /**
   * What the row is called. Rendered as the button's text, so it is both the
   * accessible name and the visible one -- never an `aria-label`, which
   * would let the announced string and the read string drift apart
   * (`CLAUDE.md`).
   */
  readonly headline: string;
  /**
   * A secondary label for the right-hand end of the title line -- `xxx`'s
   * site name today. Omitted renders nothing at all, not an empty element.
   *
   * **Inside the button, so it is announced and so it is clickable.** The
   * alternative -- rendering it in the `<h2>` beside the button -- would
   * leave a strip of the title row that looks like the title and does not
   * open the card, and would drop the site from the button's accessible
   * name while leaving it on screen. Putting visible text where a screen
   * reader cannot reach it is the same mistake as naming a control with
   * text nobody can see (`CLAUDE.md`), pointed the other way.
   *
   * So a card with a trailing label announces as `<headline> <trailing>`.
   * `plugin-xxx/test/browser.test.tsx` pins that composed name literally,
   * because it is a real change to what the control is called.
   */
  readonly trailing?: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}

/**
 * A card's title, as the control that opens it.
 *
 * `<h2>`: one level under the category screen's `<h1>`, which is the level
 * `web/src/styles/library.css` styles a card's title at. The heading level
 * is web's business and is why this component, rather than each card,
 * decides it -- a plugin choosing `<h3>` would render unstyled and announce
 * a hierarchy the page does not have.
 *
 * The headline is wrapped in a `<span>` rather than left as a bare text
 * node so that it and {@link CardHeadingProps.trailing} are two elements
 * web's stylesheet can lay out against each other. A bare text node beside
 * an element becomes an anonymous flex item, which no selector can reach.
 */
export function CardHeading({ headline, trailing, expanded, onToggle }: CardHeadingProps): ReactElement {
  return (
    <h2>
      <button type="button" aria-expanded={expanded} onClick={onToggle}>
        {/*
          `title` so the full headline is reachable when the rendered one
          is cut off. Web's `article h2 button span` truncates this to one
          line with an ellipsis so that a card's trailing label is always
          visible (`web/src/styles/library.css`), and a headline can be a
          release filename -- the longest string the app renders and the
          one an operator most needs to read exactly. This is the same
          call `ReleaseList.tsx` makes for a release row's filename, one
          component over, against the same rule shape.

          It does **not** change what the button announces: `title` is the
          last fallback in the accessible-name algorithm, so an element
          with content is named by its content, and the button is named
          from its subtree's content either way.

          **That is reasoning, and no test here can currently turn it
          into evidence** -- said plainly rather than left to look
          pinned. `title` and the text node are the same prop, so
          whichever branch of the algorithm wins, the name comes out
          identical; a test cannot tell the two apart while they agree.
          What `plugin-ui/test/expansion.test.tsx` does pin is the day
          they stop agreeing: the attribute is asserted equal to the
          rendered text, and the button's *composed* two-part name is
          asserted with a trailing label present -- so a future `title`
          carrying something else (a path, a composed summary) fails
          there, which is the change that would make the algorithm's
          answer matter.
        */}
        <span title={headline}>{headline}</span>
        {/*
          `<small>`, and not a `<span>` with a class, because this package
          ships markup and web ships the CSS (`plugin.ts`'s `Card` doc) and
          web's stylesheets set no classes anywhere -- so web needs an
          element it can select structurally. `<small>` is the element that
          already means side-comment fine print, it appears nowhere else in
          the rendered app, and `article h2 button small` in
          `web/src/styles/library.css` is what dims it and declares that it
          is never the item that gives way. **What puts it at the
          right-hand end is the headline beside it**, which takes the
          line's slack (`article h2 button span`'s `flex: 1`) and
          truncates rather than pushing this out of the card. An earlier
          version of this comment credited the `small` rule's own
          `margin-left: auto` with the push; that declaration is gone,
          because a headline that grows leaves no free space for an auto
          margin to absorb.

          **Rendered only when there is something to say.** An
          always-present empty `<small>` would still be a flex item, so a
          heading with no label would be laid out as though it had one,
          and nothing in the markup would distinguish the two.
          Conditional keeps them honestly different.
        */}
        {trailing !== undefined && <small>{trailing}</small>}
      </button>
    </h2>
  );
}
