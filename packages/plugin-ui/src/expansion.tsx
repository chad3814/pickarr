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
 * three cards; a fresh identity per render is a new prop per render for
 * every card on a paged list.
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
        <span>{headline}</span>
        {/*
          `<small>`, and not a `<span>` with a class, because this package
          ships markup and web ships the CSS (`plugin.ts`'s `Card` doc) and
          web's stylesheets set no classes anywhere -- so web needs an
          element it can select structurally. `<small>` is the element that
          already means side-comment fine print, it appears nowhere else in
          the rendered app, and `article h2 button small` in
          `web/src/styles/library.css` is what pushes it right and dims it.

          **Rendered only when there is something to say.** An always-present
          empty `<small>` would still be a flex item, so `space-between`
          would have nothing to push against and the headline would sit
          where it does now purely by accident -- a card that later gained a
          trailing label would shift its own title. Conditional keeps the
          two-child and one-child layouts honestly different.
        */}
        {trailing !== undefined && <small>{trailing}</small>}
      </button>
    </h2>
  );
}
