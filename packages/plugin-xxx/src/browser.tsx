/**
 * `plugin-xxx`'s browser card: `item.title` in the expander button, and
 * the release list once the card expands -- the same output the shared
 * card (`web/src/library/MediaItemCard.tsx`) renders for this plugin
 * today. `XxxRead.siteName` is out of scope for this card (spec §7.2):
 * porting this plugin across the seam unchanged is what proves the seam
 * is not TV-shaped, so `tables` below is `[]` and this module reads
 * nothing from `rows`.
 *
 * **Imports nothing from node, and not this package's own `index.ts`.**
 * `index.ts` reaches `@pickarr/openmetadata` and, through it, `node:sqlite`
 * -- exactly the import `npm run build`'s browser bundle cannot carry
 * (Global Constraint). This module reaches only into `@pickarr/plugin-ui`.
 */
import { useState, type ReactElement } from 'react';
import { ReleaseList, type BrowserPlugin, type CardProps } from '@pickarr/plugin-ui';

function XxxCard({ item, gathered, onExpand, submit }: CardProps): ReactElement {
  const [expanded, setExpanded] = useState(false);

  return (
    <article>
      <h2>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            // `onExpand` is idempotent (`@pickarr/plugin-ui`'s own doc), but
            // it is called only on the transition into expanded rather than
            // on every click, so collapsing this card back down asks web for
            // nothing.
            if (!expanded) onExpand();
            setExpanded(!expanded);
          }}
        >
          {item.title}
        </button>
      </h2>
      {expanded && gathered !== undefined && <ReleaseList releases={gathered.releases} submit={submit} />}
    </article>
  );
}

/**
 * `@pickarr/plugin-ui`'s `BrowserPlugin` for this plugin. `id: 'xxx'`
 * matches `index.ts`'s `XXX_PLUGIN_ID` and `MediaItemSyncRead.pluginId`
 * for every item this plugin creates (not imported from `index.ts` -- see
 * this file's own doc); `label: 'XXX'` matches
 * `packages/web/src/pluginLabels.ts`'s `PLUGIN_LABELS.xxx`, the one other
 * place this repo spells this plugin's display name. `tables: []` -- see
 * this file's own doc.
 */
export const xxxBrowser: BrowserPlugin = {
  id: 'xxx',
  label: 'XXX',
  tables: [],
  Card: XxxCard,
};
