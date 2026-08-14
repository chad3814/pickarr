import { useEffect, useState } from 'react';
import { api, type ConfigResponse } from '../api/client.ts';
import { ConfigForm, toDraft, toSubmission, type ConfigDraft } from '../components/settings/ConfigForm.tsx';

/**
 * Configuration and installation-level actions.
 *
 * Nothing here changes the running process: config is read once at boot, so a
 * save reports a pending restart rather than claiming to have applied anything,
 * and applying it is a separate, explicitly-labelled action. See §9 of the
 * design for why that is a button and not something a save does on your behalf.
 */
export function Settings() {
  const [loaded, setLoaded] = useState<ConfigResponse | null>(null);
  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const next = await api.config();
        if (cancelled) return;
        setLoaded(next);
        setDraft(toDraft(next.config));
        setRestartRequired(next.restartRequired);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Compared against what was loaded rather than tracked with a dirty flag, so
  // editing a field back to its original value correctly disables Save again.
  const dirty =
    loaded !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(toDraft(loaded.config));

  async function save(): Promise<void> {
    if (loaded === null || draft === null) return;
    const submitted = toSubmission(draft, loaded.config);
    if ('error' in submitted) {
      setNotice(null);
      setError(submitted.error);
      return;
    }

    try {
      await api.saveConfig(submitted);
      // Re-read, so the redacted view of any secret just replaced comes back as
      // `set` and the form stops offering to submit the literal again. The
      // draft is reseeded from the response for the same reason.
      const next = await api.config();
      setLoaded(next);
      setDraft(toDraft(next.config));
      setRestartRequired(true);
      setNotice('Saved. Pickarr is still running the settings it booted with.');
      setError(null);
    } catch (cause) {
      setNotice(null);
      // The draft is deliberately left alone: the edit that was refused is the
      // one the user needs in front of them to correct.
      setError((cause as Error).message);
    }
  }

  async function restart(): Promise<void> {
    try {
      await api.restart();
      setRestarting(true);
      setNotice('Restarting. This page will not update until Pickarr is back.');
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  async function backUp(): Promise<void> {
    try {
      const { blob, filename } = await api.backupDatabase();
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      setNotice(`Downloaded ${filename}`);
      setError(null);
    } catch (cause) {
      setNotice(null);
      setError((cause as Error).message);
    }
  }

  return (
    <section>
      <h1>Settings</h1>
      {notice !== null && <p className="notice">{notice}</p>}
      {error !== null && <p className="error">{error}</p>}

      {loaded !== null && draft !== null && (
        <>
          <ConfigForm
            config={loaded.config}
            draft={draft}
            portOverride={loaded.portOverride}
            onChange={setDraft}
          />

          <div className="settings-actions">
            <button type="button" disabled={!dirty} onClick={() => void save()}>
              Save
            </button>
            {restartRequired && !restarting && (
              <button type="button" onClick={() => void restart()}>
                Restart now
              </button>
            )}
          </div>

          <fieldset>
            <legend>Database</legend>
            <p className="manual-help">
              A consistent copy taken while Pickarr keeps running, downloaded to this browser.
            </p>
            <button type="button" onClick={() => void backUp()}>
              Back up &amp; download database
            </button>
          </fieldset>
        </>
      )}
    </section>
  );
}
