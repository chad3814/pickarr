import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaLink, personLink, providerDisplayName, providerRefId } from '../src/links.ts';

// Every reference below was read off a live `/api/v1/lookup` answer, and
// every url was verified by status code. They are not constructed to fit
// the parser -- inventing fixtures for a third party's format is what cost
// the artwork feature its first deployment (743 dead jobs).

test('a tmdb reference is composite and a tvdb or tpdb one is bare', () => {
  assert.equal(providerRefId('tmdb:movie:335984'), '335984');
  assert.equal(providerRefId('tmdb:tv:1399:1:1'), '1399');
  assert.equal(providerRefId('tmdb:person:30614'), '30614');
  assert.equal(providerRefId('184871'), '184871');
  assert.equal(providerRefId('5e8911b9-8e6d-4fa9-af95-f4788281551e'), '5e8911b9-8e6d-4fa9-af95-f4788281551e');
});

test('a reference this build cannot read yields no link, rather than a url that 404s', () => {
  // Review Focus 5. The browser twin of the artwork incident: a format
  // change must cost an icon, never produce
  // `themoviedb.org/movie/tmdb%3Amovie%3A335984`.
  assert.equal(providerRefId('184871:s14'), undefined, 'a tvdb season is not an id');
  assert.equal(providerRefId(''), undefined);
  assert.equal(mediaLink('tmdb', '184871:s14'), undefined);
  assert.equal(mediaLink('tmdb', null), undefined, 'an unclaimed item has no ref');
  assert.equal(mediaLink(null, '335984'), undefined, 'an unclaimed item has no provider');
  assert.equal(mediaLink('imdb', '335984'), undefined, 'no pattern for this provider');
});

test('media links are the id-addressable route each provider actually serves', () => {
  // Spelled literally. `thetvdb.com/series/184871` is a **404** -- TheTVDB's
  // pages are slug-based and `/dereferrer/<type>/<id>` is the id route.
  // Verified by status code, not inferred from TMDB's shape.
  assert.deepEqual(mediaLink('tmdb', 'tmdb:movie:335984'), {
    label: 'TMDb', href: 'https://www.themoviedb.org/movie/335984',
  });
  assert.deepEqual(mediaLink('tmdb', 'tmdb:tv:1399:1:1'), {
    label: 'TMDb', href: 'https://www.themoviedb.org/tv/1399',
  });
  assert.deepEqual(mediaLink('tvdb', '184871'), {
    label: 'TVDb', href: 'https://thetvdb.com/dereferrer/series/184871',
  });
  assert.deepEqual(mediaLink('tpdb', '5e8911b9-8e6d-4fa9-af95-f4788281551e'), {
    label: 'TPDb', href: 'https://theporndb.net/scenes/5e8911b9-8e6d-4fa9-af95-f4788281551e',
  });
});

test('person links reach each provider’s own person page', () => {
  assert.equal(personLink('tmdb', 'tmdb:person:30614'), 'https://www.themoviedb.org/person/30614');
  assert.equal(personLink('tvdb', 'tvdb:person:7892648'), 'https://thetvdb.com/dereferrer/people/7892648');
  // ThePornDB's *API* answers 404 for `/performers/{ref}` -- which is why
  // the artwork source reads performers out of the scene payload -- but the
  // *website* resolves the same uuid. Verified; do not "fix" this back.
  assert.equal(
    personLink('tpdb', '7a7a5268-c6be-48fb-9e27-96f9f9144201'),
    'https://theporndb.net/performers/7a7a5268-c6be-48fb-9e27-96f9f9144201',
  );
  assert.equal(personLink('tvdb', '184871:s14'), undefined);
});

test('provider display names are for the attribution line', () => {
  assert.equal(providerDisplayName('tmdb'), 'The Movie Database');
  assert.equal(providerDisplayName('tvdb'), 'TheTVDB');
  assert.equal(providerDisplayName('tpdb'), 'ThePornDB');
  assert.equal(providerDisplayName('nobody'), undefined);
});
