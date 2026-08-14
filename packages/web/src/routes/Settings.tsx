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
  const [saving, setSaving] = useState(false);

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
    if (loaded === null || draft === null || saving) return;
    const submitted = toSubmission(draft, loaded.config);
    if ('error' in submitted) {
      setNotice(null);
      setError(submitted.error);
      return;
    }

    // Guards the whole request, not just the PUT: the confirmation `GET`
    // below is part of the same save from the user's point of view, and a
    // second click landing mid-confirmation could still race the re-read
    // that reseeds the draft.
    setSaving(true);
    try {
      try {
        await api.saveConfig(submitted);
      } catch (cause) {
        setNotice(null);
        // The draft is deliberately left alone: the edit that was refused is
        // the one the user needs in front of them to correct.
        setError((cause as Error).message);
        return;
      }

      try {
        // Re-read, so the redacted view of any secret just replaced comes back
        // as `set` and the form stops offering to submit the literal again.
        // The draft is reseeded from the response for the same reason.
        // `restartRequired` comes from this response rather than being
        // assumed true: the server deep-compares the merged document against
        // what the process booted from, and a save that writes back exactly
        // that needs no restart.
        const next = await api.config();
        setLoaded(next);
        setDraft(toDraft(next.config));
        setRestartRequired(next.restartRequired);
        setNotice('Saved. Pickarr is still running the settings it booted with.');
        setError(null);
      } catch (cause) {
        // The write already landed — only the confirmation read failed. This
        // is not a failed save: PUT already succeeded, so reporting it as an
        // error (with `error`, the same styling a refused save uses) would be
        // a false alarm. A restart is assumed pending because the failed read
        // cannot say whether the write changed anything.
        setRestartRequired(true);
        setNotice(
          `Saved, but could not confirm the result: ${(cause as Error).message}. Reload this page to see what was written.`,
        );
        setError(null);
      }
    } finally {
      setSaving(false);
    }
  }

  async function restart(): Promise<void> {
    try {
      await api.restart();
      setRestarting(true);
      setNotice(
        "Restarting now: Pickarr is shutting down. It only comes back on its own if something supervises it — for example Docker's restart: unless-stopped — otherwise, start it again yourself.",
      );
      setError(null);
    } catch (cause) {
      setNotice(null);
      setError((cause as Error).message);
    }
  }

  async function backUp(): Promise<void> {
    try {
      const { blob, filename } = await api.backupDatabase();
      const url = URL.createObjectURL(blob);
      // An anchor that is never attached to the document, clicked, and then
      // revoked in the same tick is the classic shape that aborts a download
      // in Firefox and Safari: both can require the element to be in the DOM
      // when `click()` fires, and revoking the object URL synchronously right
      // after can race the navigation `click()` just started. Appending it
      // and deferring the revoke to a macrotask avoids both.
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
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
            <button type="button" disabled={!dirty || saving} onClick={() => void save()}>
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
