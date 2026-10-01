/*
# Library

Class manages group definitions stored in localStorage

It is the sole writer of the registry; GroupRegistry is a leaf module
so [DefiningRelations](./DefiningRelations.ts.md) and
[IsomorphicGroups](./IsomorphicGroups.ts.md) can read it without a dependency cycle.

Group definitions are stored as JSON strings, keyed by the group's ref: a
GAPID_GROUP_PREFIX URI for curated (base/extended) groups, or the GENERATED_GROUP_PREFIX
URI of the presentation from which a generated group was built.
The group objects created from these JSON strings are cached as key-value pairs
in library.

Method overview (* are exported):
 * absoluteURL -- get absolute URL from relative
 * dataToGroup -- make group object from JSON string, XML string
 * deleteGroups* -- remove groups from Library
 * decorateGeneratedGroup -- add some basic properties to generated group
 * formatGenerators -- format array of generators for use in generated group definition
 * formatRelators -- format array of relators for use in generated group definition
 * formatRelator -- format single relator for use in generated group definition
 * getGroupByRef* -- return group from library by ref (or legacy source URL), generating it if needed
 * getStoredGroups -- get group library from local store
 * loadFromPageURL* -- get groupURL from window.location.href and return Promise to load it
 * loadFromStoredGroups* -- populate in-memory library from object
 * loadLibrary* -- load library from object store
 * saveGroup* -- store group in Library
 * saveLibrary* -- persist the in-memory group library to IndexedDB right now
 * updateGroups* -- fetch/generate exactly the groups named in a build manifest: (re)fetch base
     .group files from the server, (re)generate the extended-library groups, persist the result

```js
*/

import { isExtendedManifestEntry } from './AutoUpgrade.js'
import { BitSet } from './BitSet.js'
import * as DefiningRelations from './DefiningRelations.js'
import { Group } from './Group.js'
import * as GroupRegistry from './GroupRegistry.js'
import * as IsomorphicGroups from './IsomorphicGroups.js'
import * as Log from './Log.js'
import * as StoredObjects from './StoredObjects.js'
import * as XMLGroup from './XMLGroup.js'

import type { ExtendedManifestEntry } from './AutoUpgrade.ts'
import type { GroupFileJSON } from './Group.ts'
import type { Subgroup } from './Subgroup.ts'

export { getAllGroups, getGroupsByOrder } from './GroupRegistry.js'

export const GENERATED_GROUP_PREFIX = "data:,//GE3/generated"
export const GAPID_GROUP_PREFIX = "data:,//GE3/gapid"

const library = GroupRegistry.groups

// Load group library from local store
export async function loadLibrary () {
   const storedGroupsJSON = ((await StoredObjects.getGroupLibrary()) || []) as GroupFileJSON[]
   loadFromStoredGroups(storedGroupsJSON)
}

// Populate the in-memory library from an array of GroupFileJSON objects
// (This routine is also called directly during DB migration, when the DB connection
//   isn't available for a normal loadLibrary() call)
export function loadFromStoredGroups (storedGroupsJSON: unknown) {
   library.clear()
   ;(storedGroupsJSON as GroupFileJSON[]).forEach((json) => {
      const group: Group = Group.fromLocalCopyJSON(json)
      library.set(group.ref, group)
   })
}

// get absolute URL from relative
function absoluteURL (url: string): string {
   return new URL(url, window.location.href).href
}

function dataToGroup (data: unknown, contentType: string = ''): Group {
  let group: Group
  if (typeof data === 'string' && data.startsWith('{')) {
     group = Group.fromGroupFileJSON(JSON.parse(data))
  } else if (typeof data === 'string' && data.startsWith('<!DOCTYPE groupexplorerml>')) {
     group = XMLGroup.fromGroupFileXML(data)
  } else if (contentType.includes('xml')) {
     group = XMLGroup.fromGroupFileXML(data as string)
  } else if (contentType.includes('json')) {
     group = Group.fromGroupFileJSON(data as GroupFileJSON)
  } else {
     throw (new Error('Unrecognizable data in Library:dataToGroup'))
  }

  return group
}

// delete array of groups from library and update local store
export function deleteGroups (groups: Group[]) {
   for (const group of groups) {
      library.delete(group.ref)
      deletedGroupURLs.push(group.ref)
   }
   scheduleLocalStoreUpdate()
}

// Fill in name, definition, declared generators, and presentation-matching element
// representations for a freshly-generated group that has no isomorph already in the registry.
function decorateGeneratedGroup (
   group: Group,
   generatorNames: string[],
   relators: string[],
   generatorElements: groupElement[]
): void {
   const namePrefix = `A Generated Group of Order ${group.order}`
   const nameSuffix = Math.max(
      ...GroupRegistry.getGroupsByOrder(group.order)
         .filter((G) => G.name.startsWith(namePrefix))
         .map((G) => G.name.slice(namePrefix.length).match(/\d/))
         .map((match) => parseInt((match as RegExpMatchArray)[0])),
      -1)
   group.names = [namePrefix + ` (${nameSuffix + 1})`]
   group.shortName = `Generated_${group.order}`
   group.definition = `⟨${formatGenerators(generatorNames)} : ${formatRelators(relators)}⟩`
   group.ref = `${GENERATED_GROUP_PREFIX}?${generatorNames.join(',')}:${formatRelatorsAsString(relators)}`
   group.notes = 'Generated from definition'
   group.declaredGenerators = []

   // put generators from group.subgroups first if it's shorter
   const groupAsSubgroup = group.subgroups.at(-1) as Subgroup
   if (groupAsSubgroup.generators.popcount() < generatorElements.length) {
      group.declaredGenerators.push(groupAsSubgroup.generators.toArray())
   }
   group.declaredGenerators.push(generatorElements)

   // generate element representations that match the presentation
   const reps: string[] = Array(group.order)
   reps[0] = generatorNames.includes('e')  // 'e' if it's not a generator; else 0 if group is Abelian, or 1 if not
      ? (group.isAbelian ? '0' : '1')
      : 'e'
   const queue: [groupElement, string][] = [[0, '']]
   const todo = new BitSet(group.order).setAll()
   todo.clear(0)
   while (todo.popcount() != 0) {
      const [el, rep]: [groupElement, string] = queue.shift() as [groupElement, string]
      for (let genIndex = 0; genIndex < generatorElements.length; genIndex++) {
         const el_x_gen = group.multtable[el][generatorElements[genIndex]]
         if (reps[el_x_gen] == null) {
            todo.clear(el_x_gen)
            reps[el_x_gen] = rep + generatorNames[genIndex]
            queue.push([el_x_gen, reps[el_x_gen]])
         }
      }
   }
   group.representations = [reps.map((rep) => formatRelator(rep))]
}

function formatGenerators (generators: string[]) {
   const formattedGenerators = generators
      .map((gen) => `<i>${gen}</i>`)
      .join(', ')

   return formattedGenerators
}

function formatRelators (relators: string[]) {
   const formattedRelators = relators
      .map((relator) => formatRelator(relator) + '=<wbr>')
      .join('') + '1'

   return formattedRelators
}

function formatRelatorsAsString (relators: string[]) {
   return formatRelators(relators)
      .replaceAll('<i>', '')
      .replaceAll('</i>', '')
      .replaceAll('<sup>', '')
      .replaceAll('</sup>', '')
      .replaceAll('<wbr>', '')
}

function formatRelator (relator: string) {
   const translatedRelator = []
   let currentChar = relator.charAt(0)
   let currentCount = 1
   for (let inx = 1; inx <= relator.length; inx++) {
      const char = relator.charAt(inx)
      if (char == currentChar) {
         currentCount++
      } else {
         translatedRelator.push(`<i>${currentChar.toLowerCase()}</i>`)
         if (currentChar == currentChar.toUpperCase()) {
            translatedRelator.push(`<sup>-${currentCount}</sup>`)
         } else if (currentCount > 1) {
            translatedRelator.push(`<sup>${currentCount}</sup>`)
         }
         currentChar = char
         currentCount = 1
      }
   }

   return translatedRelator.join('')
}

// returns group from library by ref (or legacy source URL), generating it if needed
export function getGroupByRef (url: string): Maybe<Group> {
   let group: Maybe<Group> = url.startsWith('data:,//GE3') ? library.get(url) : null
   if (!url.startsWith('data:,//GE3')) {  // legacy support for true URLs
      group = GroupRegistry.getAllGroups().find((group) => group.sourceURL === absoluteURL(url))
   } else if (group == null && url.startsWith(GENERATED_GROUP_PREFIX)) {  // asking for a generated group we don't have
      const presentation = new URL(url).search.slice(1)
      const result = DefiningRelations.generateGroupFromPresentation(presentation)
      if (result != null) {
         const candidate = Group.fromMulttable(result.multtable)
         // library invariant: groups are unique up to isomorphism -- prefer an existing
         // match over decorating and saving a redundant generated duplicate
         const isomorphicGroup = IsomorphicGroups.find(candidate)
         if (isomorphicGroup != null) {
            group = isomorphicGroup
         } else {
            const [generatorNames, relators] = DefiningRelations.parseFormattedPresentation(presentation)
            decorateGeneratedGroup(candidate, generatorNames, relators, result.generators)
            candidate.library = 'generated'
            saveGroup(candidate)
            group = candidate
         }
      }
   }

   return group
}

// get groupURL from page invocation and return promise for resolution from cache or download
export async function loadFromPageURL (): Promise<Group> {
   try {
      const hrefURL = new URL(window.location.href)
      const groupURL = hrefURL.searchParams.get('groupURL')
      let result: Maybe<Group> = null
      if (groupURL != null) {
         result = getGroupByRef(groupURL)
         if (result == null) {
            if (groupURL.startsWith('data:,//GE3')) {  // a ref, not a downloadable URL
               throw new Error(`Failed to generate group from URI "${groupURL}"`)
            } else {
               result = await downloadGroup(groupURL)
            }
         }
/* FIXME: this code has been dead for a while, but we don't want to lose it
 *   see https://github.com/nathancarter/gap-pkg-groupexplorer for its intended use

      } else if (hrefURL.searchParams.get('waitForMessage') !== null) {
        return new Promise((resolve, reject) => {
          /*
           * When this page is loaded in an iframe, the parent window can
           * indicate which group to load by passing the full JSON
           * definition of the group in a postMessage() call to this
           * window, with the format { type: 'load group', group: G },
           * where G is the JSON data in question.
           * /
          window.addEventListener('message', function (event /*: MessageEvent * /) {
            const eventData = (event.data /*: any * /)
            if (typeof eventData === 'undefined') {
              Log.err('empty message received in Library.js:')
              Log.err(eventData)
              reject(new Error('empty message received in Library.js'))
            } else if (eventData.source === 'editor' ||
              eventData.source === 'external' ||
              eventData === LISTENER_READY_MESSAGE ||
              eventData === STATE_LOADED_MESSAGE
            ) {
              // Sheet editor messages -- ignore them, they belong to CayleyDiagram.js : receiveInitialSetup
            } else if (eventData.type === 'load group') {
              const loadGroupMessage /*: MSG_loadGroup * / = eventData
              try {
                if (typeof loadGroupMessage.group === 'object') {
                  const group = dataToGroup(loadGroupMessage.group, 'json')
                  if (group != null) {
                    map[group.shortName] = group
                    resolve(group)
                  }
                }
                reject(new Error('unable to understand loadGroupMessage'))
              } catch (error) {
                reject(error)
              }
            } else {
              Log.err('unknown message received in Library.js:')
              Log.err(eventData)
              reject(new Error('unknown message received in Library.js'))
            }
          }, false)
        })
      }
 */
      } else {
         throw new Error("error in URL: can't find groupURL query parameter")
      }

      return result as Group
   } catch (error: unknown) {
      Log.err(`Unable to load page from URL ${window.location.href}:\n${(error as Error).message}`)
      throw(error)
   }

   async function downloadGroup (url: string): Promise<Group> {
      const groupURL = absoluteURL(url)
      const result: Promise<Group> = new Promise((resolve, reject) => {
         window.fetch(groupURL)
            .then(async (response) => {
               try {
                  if (response.ok) {
                     const data = await response.text()
                     const contentType = response.headers.get('content-type') ?? ''
                     const remoteGroup = dataToGroup(data, contentType)
                     if (remoteGroup == null) {
                        reject(new Error(
                           `Error reading ${groupURL}: unknown content type ${contentType}`,
                           {cause: response}))
                     } else {
                        remoteGroup.lastModifiedOnServer = response.headers.get('last-modified')
                        remoteGroup.sourceURL = groupURL
                        // not a curated library group, so its identity is its (host-specific) location:
                        //   a gapid ref could collide with, and replace, the curated group of that gapid
                        remoteGroup.ref = groupURL
                        saveGroup(remoteGroup)
                        resolve(remoteGroup)
                     }
                  } else {
                     const errorMsg = `\nError fetching ${groupURL}` +
                        `\nReason: ${response.statusText || 'N/A'}` +
                        `\nHTTP status code: ${response.status || 'N/A'}`
                     reject(new Error(errorMsg, {cause: response}))
                  }
               } catch (parseError) {
                  reject(new Error(`Error parsing ${groupURL}`, {cause: parseError}))
               }
            })
            .catch((error: Error) => {
               throw new Error(`${error.name} on fetch from ${groupURL}`, {cause: error})
            })
      })

      return result
   }
}

// updates library group definitions and schedules local store update
export function saveGroup (group: Maybe<Group>) {
   if (group != null) {
      if (library.has(group.ref)) {
         updatedGroupURLs.push(group.ref)
      } else {
         createdGroupURLs.push(group.ref)
      }
      library.set(group.ref, group)
   }
   scheduleLocalStoreUpdate()
}

type LibraryUpdate = {
   source: 'library',
   created: string[],
   updated: string[],
   deleted: string[]
}

export function isLibraryUpdate(message: unknown): message is LibraryUpdate {
   return message != null
      && typeof message === 'object'
      && 'source' in message
      && message.source === 'library'
      && Array.isArray((message as Record<string, unknown>).created)
      && Array.isArray((message as Record<string, unknown>).updated)
      && Array.isArray((message as Record<string, unknown>).deleted)
}

// schedule local store group library update
let savedTimeoutID: Maybe<number> = null
const createdGroupURLs: string[] = []
const updatedGroupURLs: string[] = []
const deletedGroupURLs: string[] = []
function scheduleLocalStoreUpdate () {
   if (savedTimeoutID != null) {
      window.clearTimeout(savedTimeoutID)
   }
   savedTimeoutID = window.setTimeout(async () => {
      savedTimeoutID = null
      let maybeMessage: Maybe<LibraryUpdate> = null
      if (createdGroupURLs.length != 0 || updatedGroupURLs.length != 0 || deletedGroupURLs.length != 0) {
         maybeMessage = {
            source: 'library',
            created: [...createdGroupURLs],
            updated: [...updatedGroupURLs],
            deleted: [...deletedGroupURLs]
         }
         createdGroupURLs.length = 0
         updatedGroupURLs.length = 0
         deletedGroupURLs.length = 0
      }
      await saveLibrary()  // wait for store to complete before exiting
      if (maybeMessage != null) {
         const channel = new BroadcastChannel('GE3-channel')
         channel.postMessage(maybeMessage)
         channel.close()
      }
   })
}

/*
```
### saveLibrary

Persist the in-memory group library to IndexedDB right now — the counterpart to `loadLibrary`,
and the one write callers can rely on having completed (`saveGroup` only *schedules* a debounced
write). `updateGroups` finishes with it.
```javascript
 */
export function saveLibrary (): Promise<unknown> {
   return StoredObjects.saveGroupLibrary(Array.from(library.values()))
}

// Fetch/generate exactly the groups named in a manifest -- a mix of base-library `.group` URLs
// (strings) and extended-library entries (ExtendedManifestEntry, generated from a presentation)
// -- and save the result. Only touches these; a group already in the library under some other
// URL is left alone. (It used to also refetch every URL already in the library, regardless of
// the manifest -- but the only caller always passes the complete catalog anyway, so that added
// no real coverage; it only meant one stray/unreachable URL left over in a user's library -- an
// externally-loaded group, or a base group later dropped from the catalog -- could fail the
// single `Promise.all` below and abort the refresh of every *other* group along with it.) Called
// by AutoUpgrade.refreshGroupLibrary on a version bump.
export async function updateGroups (manifest: ReadonlyArray<string | ExtendedManifestEntry>) {
   await loadLibrary()

   // base library: (re)fetch one .group file, honoring If-Modified-Since and preserving any
   // user customization already stored for it
   const refreshFetchedGroup = async (groupURL: string): Promise<void> => {
      const localGroup = getGroupByRef(groupURL)

      const options: RequestInit = { cache: 'no-cache', mode: 'no-cors' }
      if (localGroup?.lastModifiedOnServer != null) {
         options.headers = { 'If-Modified-Since': localGroup.lastModifiedOnServer }
      }

      const response: Response = await window.fetch(groupURL, options)

      if (response.status == 200) {  // response status == 304 if not modified
         const text = await response.text()
         const freshGroup = dataToGroup(text)
         freshGroup.lastModifiedOnServer = response.headers.get('last-modified')
         freshGroup.sourceURL = groupURL
         freshGroup.ref = `${GAPID_GROUP_PREFIX}?${freshGroup.gapid}`

         // preserve user customization
         if (localGroup?.custom != null) {
            Object.assign(freshGroup.custom, localGroup.custom)
         }

         library.set(freshGroup.ref, freshGroup)
      }
   }

   // extended library: generate the group from its presentation, and add the manifest's curated metadata
   // extended-library groups are curated by presentation, not deduplicated against isomorphic library entries
   const generateExtendedGroup = (entry: ExtendedManifestEntry): void => {
      let group = library.get(`${GAPID_GROUP_PREFIX}?${entry.gapid}`)
      if (group == null) {
         const result = DefiningRelations.generateGroupFromPresentation(entry.presentation)
         if (result != null) {
            group = Group.fromMulttable(result.multtable)
            const [generatorNames, relators] = DefiningRelations.parseFormattedPresentation(entry.presentation)
            decorateGeneratedGroup(group, generatorNames, relators, result.generators)
            group.library = 'extended'
         }
      }
      if (group != null) {
         group.gapid   = entry.gapid
         group.gapname = entry.gapname
         group.names   = entry.names
         group.ref = `${GAPID_GROUP_PREFIX}?${entry.gapid}`
         if (entry.link != null)   group.links  = [entry.link]
         if (entry.phrase != null) group.phrase = entry.phrase
         saveGroup(group)
      }
   }

   // fetch every base URL named in the manifest, then generate the extended groups
   const fetchURLs: Set<string> = new Set(manifest.filter((entry): entry is string => typeof entry === 'string'))
   await Promise.all(Array.from(fetchURLs).map(refreshFetchedGroup))
   manifest.filter(isExtendedManifestEntry).forEach(generateExtendedGroup)

   // Persist now and await it. The saveGroup calls above only *schedule* a debounced write, and
   // a caller (AutoUpgrade.initialize) advances the stored version number the moment this
   // resolves -- a reload or browser/OS restart before the debounce timer fires would pair the
   // new version number with a stale library. That bug has bitten before; keep the await.
   await saveLibrary()
}
