// Unit tests for Library -- focused on the parts most likely to hide a bug rather than on
// coverage percentage: the generated-group dedup invariant, the isLibraryUpdate guard that gates
// cross-tab sync, and updateGroups' refetch/preserve-customization/not-modified handling
// (exercised through a mocked fetch, since the harness's static file server can't produce a 304).

import * as Library from '../js/Library.js'
import { Group } from '../js/Group.js'

// ---- fixtures ---------------------------------------------------------------

// fetched (not read via node:fs) so this file runs unmodified in the browser too; the relative
// URL resolves against tests/ in both, via setup-library.mjs's fetch shim under Node. Read at
// import time, before any test below replaces globalThis.fetch with a mock.
const z2Text = await (await fetch('../groups/Z_2.group')).text()

before(async function () {
   this.timeout(5000)
   await Library.loadLibrary()
})

// ---- tests ------------------------------------------------------------------

describe('Library', function () {

   describe('getGroupByRef -- generated-group dedup', function () {
      it('reuses an existing library group when a presentation is isomorphic to it, rather than saving a duplicate', function () {
         // library invariant asserted in Library.ts: "groups are unique up to isomorphism"
         const Z4 = Library.getGroupByRef('../groups/Z_4.group')
         const dup = Library.getGroupByRef(`${Library.GENERATED_GROUP_PREFIX}?a:a4=1`)
         expect(dup).to.equal(Z4)
      })

      it('generates and saves a new group when nothing isomorphic is already in the library', function () {
         const url = `${Library.GENERATED_GROUP_PREFIX}?a:a41=1`   // Z_41: prime order, unlikely to collide
         const group = Library.getGroupByRef(url)
         expect(group.order).to.equal(41)
         expect(group.library).to.equal('generated')
         expect(group.ref).to.equal(url)
      })

      it('memoizes a generated group -- a second lookup does not regenerate it', function () {
         const url = `${Library.GENERATED_GROUP_PREFIX}?a:a43=1`
         const first = Library.getGroupByRef(url)
         const second = Library.getGroupByRef(url)
         expect(second).to.equal(first)
      })
   })

   describe('deleteGroups', function () {
      it('removes a group so a later lookup rebuilds it from scratch', function () {
         // use a freshly-generated group, not a base-library one other test files depend on
         const url = `${Library.GENERATED_GROUP_PREFIX}?a:a47=1`
         const first = Library.getGroupByRef(url)
         Library.deleteGroups([first])
         const second = Library.getGroupByRef(url)
         expect(second).to.not.equal(first)
         expect(second.order).to.equal(47)
      })
   })

   describe('isLibraryUpdate', function () {
      it('accepts a well-formed library-update message', function () {
         const message = { source: 'library', created: [], updated: [], deleted: [] }
         expect(Library.isLibraryUpdate(message)).to.equal(true)
      })

      it('rejects a message missing a required field', function () {
         expect(Library.isLibraryUpdate({ source: 'library', created: [], updated: [] })).to.equal(false)
      })

      it('rejects a message with the wrong source', function () {
         const message = { source: 'settings', created: [], updated: [], deleted: [] }
         expect(Library.isLibraryUpdate(message)).to.equal(false)
      })

      it('rejects non-object and null input', function () {
         expect(Library.isLibraryUpdate(null)).to.equal(false)
         expect(Library.isLibraryUpdate('library update')).to.equal(false)
         expect(Library.isLibraryUpdate(42)).to.equal(false)
      })
   })

   describe('updateGroups -- refetching over a mocked fetch', function () {
      // A group with customization and a recorded Last-Modified, saved (and flushed -- saveGroup
      // only *schedules* a debounced write, and updateGroups starts with its own loadLibrary()
      // that would otherwise discard an unflushed save) under a URL that belongs to no other
      // test. updateGroups only ever fetches URLs named in its manifest, and every test below
      // passes a manifest of exactly [fakeURL], so a blanket fetch mock only ever answers for it.
      // The fixture -- and the text the mocked fetch serves, since a 200 refetch re-derives ref from
      // the fetched gapid -- gets a fake gapid (no second group of order 2 exists), so its ref can't
      // collide with, and silently replace, the real Z_2 in the library every test file shares.
      const fakeURL = new URL('__Library_Tests_fixture__.group', 'https://example.invalid/groups/').href
      const fakeGapid = '2,9999'
      const fakeRef = `${Library.GAPID_GROUP_PREFIX}?${fakeGapid}`
      const fakeText = JSON.stringify({ ...JSON.parse(z2Text), gapid: fakeGapid })
      let originalFetch

      beforeEach(async function () {
         const fake = Group.fromGroupFileJSON(JSON.parse(fakeText))
         fake.sourceURL = fakeURL
         fake.ref = fakeRef
         fake.custom = { name: 'My Custom Name' }
         fake.lastModifiedOnServer = 'Wed, 01 Jan 2020 00:00:00 GMT'
         Library.saveGroup(fake)
         await Library.saveLibrary()
         originalFetch = globalThis.fetch
      })

      afterEach(function () {
         globalThis.fetch = originalFetch
      })

      // leave the shared library as we found it
      after(async function () {
         Library.deleteGroups([Library.getGroupByRef(fakeRef)])
         await Library.saveLibrary()
      })

      it('sends If-Modified-Since using the locally recorded lastModifiedOnServer', async function () {
         let capturedOptions
         globalThis.fetch = async (_url, options) => {
            capturedOptions = options
            return new Response(fakeText, { status: 200 })
         }
         await Library.updateGroups([fakeURL])
         expect(capturedOptions.headers['If-Modified-Since']).to.equal('Wed, 01 Jan 2020 00:00:00 GMT')
      })

      it('preserves user customization across a 200 refetch', async function () {
         globalThis.fetch = async () => new Response(fakeText, { status: 200 })
         await Library.updateGroups([fakeURL])
         expect(Library.getGroupByRef(fakeURL).custom).to.deep.equal({ name: 'My Custom Name' })
      })

      it('a 304 response leaves the stored group content untouched', async function () {
         globalThis.fetch = async () => new Response(null, { status: 304 })
         await Library.updateGroups([fakeURL])
         const group = Library.getGroupByRef(fakeURL)
         expect(group.custom).to.deep.equal({ name: 'My Custom Name' })
         expect(group.lastModifiedOnServer).to.equal('Wed, 01 Jan 2020 00:00:00 GMT')
      })
   })
})
