/**
 * Secret-*shaped* strings, redacted wherever free text reaches a log line or
 * a stored column (issue #78).
 *
 * **Why a shape and not a list of known names.** `redactText` knew one
 * parameter name, `apikey`. A private tracker's credential is conventionally
 * `passkey=`, or has no parameter at all -- `/announce/<secret>/file.torrent`
 * -- and #78 records that adding names "would cover two more shapes and
 * still miss a path-embedded secret, which has no parameter to strip". A
 * rule about what a credential *looks like* covers the path case, which no
 * list of names can.
 *
 * **Two rules, both required by the repo owner and implemented as given:**
 *
 * 1. A run of 8 or more hexadecimal characters, all one case.
 * 2. A run of 8 or more alphanumerics carrying at least two uppercase, two
 *    lowercase and two digits.
 *
 * Rule 1 deliberately matches an all-digit run, so an eight-digit byte count
 * or a thirteen-digit epoch becomes `*****`. That was chosen over sparing
 * them: a caller with a large number to log calls `.toLocaleString()`, whose
 * commas break the run into pieces shorter than eight. Note that a trailing
 * unit does **not** help -- `1700000000000ms` still contains a
 * thirteen-character run -- so the separator has to be inside the number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, redactText } from '../../src/clients/redact.ts';

/**
 * Obviously synthetic, and none of these is a credential anyone holds. They
 * are the *shapes* -- a 32-hex tracker passkey, an upper-case hash, a
 * mixed-case api key -- because the rules are about shape and a test written
 * against a short placeholder would prove nothing. `SECRET` is exactly that
 * mistake, and it is the last case below.
 */
const PASSKEY = '9f8e7d6c5b4a39281706f5e4d3c2b1a0';
const UPPER_HASH = '9F8E7D6C5B4A39281706F5E4D3C2B1A0';
const MIXED_KEY = 'Ab12Cd34Ef56';

test('a passkey in a query parameter is redacted, whatever the parameter is called', () => {
  // The case #78 opens with. `redactText` covered `apikey` and nothing else.
  assert.equal(
    redactSecrets(`https://tracker.example/rss?passkey=${PASSKEY}`),
    'https://tracker.example/rss?passkey=9f8*****',
  );
  assert.equal(
    redactSecrets(`https://tracker.example/rss?token=${PASSKEY}`),
    'https://tracker.example/rss?token=9f8*****',
  );
});

test('a passkey embedded in the path is redacted, which no parameter list could do', () => {
  // The reason #78 says this is "not a one-line fix": there is no parameter
  // to strip, so only a rule about the shape reaches it.
  assert.equal(
    redactSecrets(`https://tr.example/announce/${PASSKEY}/file.torrent`),
    'https://tr.example/announce/9f8*****/file.torrent',
  );
});

test('both letter cases of hex are covered, and a mixed-case run is covered by the second rule', () => {
  assert.equal(redactSecrets(UPPER_HASH), '9F8*****');
  assert.equal(redactSecrets(PASSKEY), '9f8*****');
  assert.equal(redactSecrets(`https://h/api?apikey=${MIXED_KEY}`), 'https://h/api?apikey=Ab1*****');
});

test('a mixed-case run needs two of each class, so ordinary words survive', () => {
  // The second rule's filter, driven from both sides. Without it,
  // `[A-Za-z0-9]{8,}` would redact most of every log line.
  assert.equal(redactSecrets('Downloading'), 'Downloading', 'letters only');
  assert.equal(redactSecrets('qbittorrent'), 'qbittorrent', 'lower only');
  assert.equal(redactSecrets('DOWNLOADING'), 'DOWNLOADING', 'upper only, and not hex');
  assert.equal(redactSecrets('Ab1cdefgh'), 'Ab1cdefgh', 'one upper, one digit -- under the bar');
  assert.equal(redactSecrets('AB12cdef'), 'AB1*****', 'two of each is the bar, and this clears it');
});

test('a run shorter than eight is left alone, in both rules', () => {
  assert.equal(redactSecrets('deadbee'), 'deadbee', 'seven hex characters');
  assert.equal(redactSecrets('Ab12Cd3'), 'Ab12Cd3', 'seven mixed characters');
});

test('release names and episode titles survive, because separators break the runs', () => {
  // Measured before the rules were chosen, and the reason they were
  // acceptable: a dotted release name has no alphanumeric run long enough
  // to trip either rule. If this ever reds, the browse screen's own text is
  // being redacted out of logs and the rules need revisiting.
  assert.equal(
    redactSecrets('Arrival.2016.1080p.BluRay.x264-GROUP'),
    'Arrival.2016.1080p.BluRay.x264-GROUP',
  );
  assert.equal(redactSecrets('JoJo.S02E47.Dios.World.1080p'), 'JoJo.S02E47.Dios.World.1080p');
});

test('an all-digit run of eight or more is redacted, and that is the chosen trade', () => {
  // Rule 1 includes `0-9`, so this is not an oversight to be "fixed" later
  // without saying so. The repo owner chose it over sparing numbers: a
  // caller with a large number to log calls `.toLocaleString()`, and the
  // commas break the run. A trailing unit does not, which is why the second
  // assertion is here rather than assumed.
  // The prefix earns its keep on exactly these: `104` and `170` are enough
  // to recognise a masked byte count and a masked epoch for what they are,
  // which is the false-positive case the three characters were added for.
  assert.equal(redactSecrets('wrote 10485760 bytes'), 'wrote 104***** bytes');
  assert.equal(redactSecrets('failed after 1700000000000ms'), 'failed after 170*****ms');
  assert.equal(
    redactSecrets(`wrote ${(10485760).toLocaleString('en-US')} bytes`),
    'wrote 10,485,760 bytes',
    'the documented way to keep a large number readable',
  );
  assert.equal(redactSecrets('timed out after 30000ms'), 'timed out after 30000ms', 'under eight');
});

test('the mask is a fixed five stars, so a match\'s length never shows through', () => {
  // Not `'*'.repeat(match.length)`: that would leak how long the credential
  // was, and a 32-hex passkey would be obvious beside a 12-character key.
  // The three-character prefix is a fixed size for the same reason -- what
  // survives is bounded by the rule, never by the secret.
  //
  // This test used to be called "every match becomes the same five stars,
  // so nothing about the secret survives its length" and asserted
  // `'***** *****'`. The first half of that name stopped being true when
  // shape matches gained a prefix; the second half is what it was always
  // really pinning, and is what it pins now.
  assert.equal(redactSecrets(`${PASSKEY} ${MIXED_KEY}`), '9f8***** Ab1*****');
  assert.equal(
    redactSecrets(PASSKEY).length,
    redactSecrets(MIXED_KEY).length,
    'a 32-character secret and a 12-character one mask to the same width',
  );
});

test('a six-character placeholder is NOT redacted, which is why fixtures must be realistic', () => {
  // `SECRET` trips neither rule, and `test/sync/tables.test.ts` pinned #78's
  // gap with exactly that string. A test written against it would have
  // stayed green straight through this change -- the failure mode its own
  // comment warned about ("the gap closing must be observable rather than
  // silent"). Asserted here so the limit is recorded rather than discovered.
  assert.equal(redactSecrets('https://tracker.example/rss?passkey=SECRET'), 'https://tracker.example/rss?passkey=SECRET');
});

test('a shape-matched run keeps its first three characters, so a false positive is identifiable', () => {
  // Every match here is found by *shape*, which means some of them are not
  // credentials at all: a torrent infohash, an eight-digit byte count, a
  // thirteen-digit epoch. Those were indistinguishable from each other and
  // from a real passkey once masked, and `reconcile.ts` logs a `ref` that
  // is exactly an infohash -- so an operator reading 200 identical
  // `*****`s could not tell which were secrets and which were the
  // redactor being wrong.
  //
  // Three characters is enough to correlate a line with a torrent in a
  // client's own UI, and to recognise a masked epoch by its leading `17`.
  assert.equal(redactSecrets(PASSKEY), '9f8*****');
  assert.equal(redactSecrets(UPPER_HASH), '9F8*****');
  assert.equal(redactSecrets(MIXED_KEY), 'Ab1*****');
});

test('the prefix comes from the match, not from what surrounds it', () => {
  // The obvious wrong implementation takes three characters off the whole
  // string rather than off each run, which would answer `htt*****` here
  // and leak nothing useful while corrupting the surrounding text.
  assert.equal(
    redactSecrets(`https://tracker.example/announce/${PASSKEY}/file.torrent`),
    'https://tracker.example/announce/9f8*****/file.torrent',
  );
});

test('two different secrets no longer mask to the same string, and that is the cost', () => {
  // **The property this deliberately gives up.** A single uniform mask made
  // two distinct credentials in a log indistinguishable from each other;
  // a prefix does not. That is not a side effect, it is the whole request
  // -- distinguishing them is how a false positive gets spotted -- but it
  // means a log now carries three characters of every secret the shape
  // rules catch. Recorded here so the trade is visible at the assertion
  // rather than only in a commit message.
  const other = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  assert.notEqual(redactSecrets(PASSKEY), redactSecrets(other));
});

test('a parameter whose name hints at a credential is masked whole, not just `apikey`', () => {
  // `redactText` knew the single name `apikey`, and while every shape match
  // was bare stars that gap cost nothing -- `redactSecrets` caught a
  // `passkey=` value anyway and hid it completely. The prefix changed that:
  // the fallback would have left three characters of a real tracker
  // passkey in a log line. The name rule now matches the same four hints
  // `redactUrl` does, so it fires first and takes the value whole.
  assert.equal(
    redactText(`https://tracker.example/rss?passkey=${PASSKEY}`),
    'https://tracker.example/rss?passkey=*****',
  );
  assert.equal(
    redactText(`https://h/x?private_token=${MIXED_KEY}&mode=list`),
    'https://h/x?private_token=*****&mode=list',
  );
  // A parameter that names no credential keeps its value, so this is
  // discrimination rather than masking every parameter in sight.
  assert.equal(redactText('https://h/x?mode=queue&limit=0'), 'https://h/x?mode=queue&limit=0');
  // And the name rule must not run across a `&` into its neighbour.
  assert.equal(
    redactText('https://h/x?apikey=Ab12Cd34Ef56&mode=queue'),
    'https://h/x?apikey=*****&mode=queue',
  );
});

test('a credential matched by name is still masked whole, prefix and all', () => {
  // The prefix is scoped to shape matches on purpose. `apikey=` is not a
  // false positive -- it is a credential identified by name -- so there is
  // nothing to diagnose and a prefix would be a leak that buys nothing.
  // `redactText` runs the name rule before the shape rules, so its `*****`
  // is what survives.
  assert.equal(
    redactText('https://sab.example/api?apikey=Ab12Cd34Ef56&mode=queue'),
    'https://sab.example/api?apikey=*****&mode=queue',
  );
});
