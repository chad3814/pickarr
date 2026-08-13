import { useEffect, useState } from 'react';
import { api, type ConfigResponse } from '../api/client.ts';

/**
 * Configuration and installation-level actions.
 *
 * The form edits `config.json` on disk; nothing here changes the running
 * process, because config is read once at boot. That is why a save reports a
 * pending restart rather than claiming to have applied anything.
 */
export function Settings() {
  const [loaded, setLoaded] = useState<ConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const next = await api.config();
        if (!cancelled) {
          setLoaded(next);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <h1>Settings</h1>
      {error !== null && <p className="error">{error}</p>}
      {loaded !== null && (
        <label className="manual-field">
          Trash directory
          <input readOnly value={loaded.config.trashDir} />
        </label>
      )}
    </section>
  );
}
