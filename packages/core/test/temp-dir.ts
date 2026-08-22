import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

/**
 * A real temporary directory that removes itself when the test ends.
 *
 * The directories are real on purpose and stay real. What these tests assert —
 * that a rename lands where it was planned, that the EXDEV fallback copies and
 * unlinks, that `realpath` containment refuses a path outside the library root,
 * that an occupied destination is refused — are properties of a filesystem, and
 * a mock filesystem would only restate what we already believe about one. Only
 * the teardown was missing.
 *
 * Registration goes through `t.after`, which runs whether the test passed or
 * threw, and runs once per registration — so a test that needs a library root
 * and a trash directory registers two and gets both back. An earlier comment on
 * `setupWithRealLibrary` in `pipeline/rekey.test.ts` said no such hook existed
 * and made every caller responsible for its own `rm`; 33 of them across four
 * files did not do it, which is the whole of this defect. Per-test `rm` calls at
 * the end of a body only run on the happy path, which is the path that did not
 * need them.
 *
 * `force: true` so a test that already removed the directory itself, or that
 * never created anything inside it, tears down silently rather than failing
 * after its assertions have passed.
 */
export async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
