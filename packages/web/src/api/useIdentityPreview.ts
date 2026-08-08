import { useEffect, useState } from 'react';
import { api } from './client.ts';

/**
 * Long enough that a typed word is one request rather than five, short enough
 * that the key appears while the user is still looking at the field.
 */
const DEBOUNCE_MS = 200;

/**
 * The identity key the plugin would build from these values, or its complaint
 * about them — whichever it is, as one string to render under the fields.
 *
 * This lives outside `ManualForm` so the form stays presentational and all
 * three callers get the same debounce. A wrong manual identity is as durable as
 * a right one and nothing validates it against reality, so this preview is the
 * only guard there is; it must not lag behind the fields it describes.
 */
export function useIdentityPreview(plugin: string, values: Record<string, string>): string {
  const [preview, setPreview] = useState('');

  // The dependency is the serialisation, not the object. Callers rebuild
  // `values` as they render, so its identity changes on renders that changed no
  // value at all — keyed on the object, an unrelated re-render of the form's
  // parent would fire a fresh request. The closure below still reads the object
  // itself, which is the one from the render that changed the serialisation.
  const serialised = JSON.stringify(values);

  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      try {
        const result = await api.manualPreview(plugin, values);
        // A rejected set of values comes back 200 with `{ error }`, because a
        // half-typed form is the normal state of a form being typed into.
        if (!cancelled) setPreview('error' in result ? result.error : result.identityKey);
      } catch (cause) {
        // Reserved for a request that genuinely failed: an unknown plugin, a
        // plugin with no manual hooks, a dropped connection.
        if (!cancelled) setPreview((cause as Error).message);
      }
    }

    const timer = setTimeout(() => void run(), DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `serialised` stands in for `values`; see above.
  }, [plugin, serialised]);

  return preview;
}
