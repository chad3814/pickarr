import type { ZodType } from 'zod';
import type { ConfigDocument } from './file.ts';
import { readConfigDocument, writeConfigDocument } from './file.ts';

export interface ConfigHandle<T> {
  /** The validated value for this namespace, as of the last read or update. */
  readonly current: T;
  /** Replaces this namespace's section, leaving every other namespace untouched. */
  update(next: T): Promise<void>;
}

export interface Config {
  /**
   * Claims a namespace and validates its section.
   *
   * The schema must accept `undefined`, because an absent section is parsed
   * as `undefined` -- so a namespace that wants to be optional carries its
   * own defaults (design spec §2.6c).
   */
  register<T>(namespace: string, schema: ZodType<T>): ConfigHandle<T>;
}

/**
 * The config file, as one namespace per subsystem.
 *
 * Two properties drive the shape:
 *
 * **An unknown namespace survives a write.** `update` re-reads the document
 * from disk and replaces only its own key, so a host that knows nothing about
 * a plugin's section cannot delete it. That is also why the document is not
 * cached for writing: the copy read at boot may be older than the file.
 *
 * **Writes are serialized.** Every `update` joins one promise chain, so two
 * concurrent calls cannot interleave their read-modify-write and lose one of
 * the two sections. Without it, the second read can happen before the first
 * write, and the first update vanishes with nothing to show it ever ran.
 */
export async function openConfig(deps: { path: string }): Promise<Config> {
  const atOpen: ConfigDocument = await readConfigDocument(deps.path);
  const claimed = new Set<string>();
  // The tail of the write chain. Each update awaits its predecessor, so the
  // read-modify-write pairs never interleave.
  let queue: Promise<void> = Promise.resolve();

  return {
    register<T>(namespace: string, schema: ZodType<T>): ConfigHandle<T> {
      if (claimed.has(namespace)) {
        throw new Error(`config namespace ${JSON.stringify(namespace)} is already registered`);
      }
      claimed.add(namespace);

      let current: T;
      try {
        current = schema.parse(atOpen[namespace]);
      } catch (error) {
        // The namespace is named because a schema error alone does not say
        // which section was wrong. The raw value is *not* included: a
        // namespace may hold anything, and this message is logged.
        //
        // `cause` is set here, unlike `file.ts`'s fs errors: a Zod error
        // names field paths and issue codes, never a filesystem path or a
        // credential, so chaining it costs nothing and makes a malformed
        // config diagnosable. Do not "fix" this by adding `cause` to
        // `file.ts` or by removing it here -- the two are asymmetric on
        // purpose, not inconsistent.
        throw new Error(
          `config namespace ${JSON.stringify(namespace)} is invalid: ` +
          `${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      return {
        get current(): T {
          return current;
        },
        async update(next: T): Promise<void> {
          const validated = schema.parse(next);
          const run = queue.then(async () => {
            const document = await readConfigDocument(deps.path);
            await writeConfigDocument(deps.path, { ...document, [namespace]: validated });
            current = validated;
          });
          // The chain must advance even when this update fails, or one
          // rejection would wedge every later write. The caller still sees
          // the rejection through `run`.
          queue = run.then(() => undefined, () => undefined);
          return run;
        },
      };
    },
  };
}
