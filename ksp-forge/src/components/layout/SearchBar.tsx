import { useEffect, useRef, useState } from 'react'
import { useUiStore, type AdvancedFilters, type CkanDiscoverFilter, type CurseForgeBrowseBy, type CurseForgeCategory } from '../../stores/ui-store'
import { useModStore } from '../../stores/mod-store'

/** Parse `author:Foo tag:Bar license:MIT installed:yes compat:1.12 rest of query`
 *  Returns { filters, plainQuery } */
function parseQueryTokens(raw: string): { filters: Partial<AdvancedFilters>; plainQuery: string } {
  const tokens = raw.trim().split(/\s+/)
  const filters: Partial<AdvancedFilters> = {}
  const plain: string[] = []

  for (const token of tokens) {
    const m = token.match(/^(author|tag|license|installed|compat):(.+)$/i)
    if (m) {
      const key = m[1].toLowerCase() as keyof AdvancedFilters
      const val = m[2]
      if (key === 'installed') filters.installed = (val === 'yes' ? 'yes' : val === 'no' ? 'no' : '')
      else (filters as any)[key] = val
    } else {
      plain.push(token)
    }
  }

  return { filters, plainQuery: plain.join(' ') }
}

const CKAN_TAG_OPTIONS = [
  'agency', 'app', 'buildings', 'career', 'combat', 'comms', 'config', 'control', 'convenience',
  'crewed', 'editor', 'first-person', 'flags', 'graphics', 'information', 'library', 'parts',
  'physics', 'planet-pack', 'plugin', 'resources', 'science', 'sound', 'stock-inventory',
  'suits', 'tech-tree', 'uncrewed', 'untagged',
]

export function SearchBar() {
  const {
    currentView, discoverSource, searchQuery, sortBy, setSearchQuery, setSortBy,
    resetFilters, advancedFilters,
    setAdvancedFilters, clearAdvancedFilters, setDiscoverSource,
    ckanStateFilter, ckanTags, ckanCustomLabel, curseForgeBrowseBy, curseForgeCategory,
    setCkanStateFilter, setCkanTags, setCkanCustomLabel, setCurseForgeBrowseBy, setCurseForgeCategory,
  } = useUiStore()
  const { searchMods, fetchMods } = useModStore()

  const [localQuery, setLocalQuery] = useState(searchQuery)
  const [showFilters, setShowFilters] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { setLocalQuery(searchQuery) }, [searchQuery])

  const handleChange = (value: string) => {
    setLocalQuery(value)
    // Parse advanced tokens out of query
    const { filters, plainQuery } = parseQueryTokens(value)
    setAdvancedFilters(filters)
    // Clear tokens not present in new value
    if (!value.match(/author:/i)) setAdvancedFilters({ author: '' })
    if (!value.match(/tag:/i)) setAdvancedFilters({ tag: '' })
    if (!value.match(/license:/i)) setAdvancedFilters({ license: '' })
    if (!value.match(/installed:/i)) setAdvancedFilters({ installed: '' })
    if (!value.match(/compat:/i)) setAdvancedFilters({ compat: '' })
    setSearchQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      if (discoverSource === 'curseforge') {
        searchMods(plainQuery.trim(), 'curseforge')
      } else if (plainQuery.trim()) {
        searchMods(plainQuery.trim(), 'ckan')
      } else {
        fetchMods()
      }
    }, 300)
  }

  const handleSourceChange = (source: 'ckan' | 'curseforge') => {
    if (source === discoverSource) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setDiscoverSource(source)

    const trimmedQuery = localQuery.trim()
    if (trimmedQuery) {
      if (source === 'curseforge') {
        searchMods(trimmedQuery, 'curseforge')
      } else {
        searchMods(trimmedQuery, 'ckan')
      }
      return
    }

    if (source === 'curseforge') {
      searchMods('', 'curseforge')
    } else {
      fetchMods()
    }
  }

  const activeFilterCount =
    (advancedFilters.author ? 1 : 0) +
    (advancedFilters.tag ? 1 : 0) +
    (advancedFilters.license ? 1 : 0) +
    (advancedFilters.installed ? 1 : 0) +
    (advancedFilters.compat ? 1 : 0) +
    (discoverSource === 'ckan' && ckanStateFilter !== 'all' ? 1 : 0) +
    (discoverSource === 'ckan' && ckanTags.length > 0 ? ckanTags.length : 0) +
    (discoverSource === 'ckan' && ckanCustomLabel ? 1 : 0) +
    (discoverSource === 'curseforge' && curseForgeBrowseBy !== 'all' ? 1 : 0) +
    (discoverSource === 'curseforge' && curseForgeCategory !== 'all' ? 1 : 0)

  return (
    <div className="border-b border-space-border bg-space-surface/50">
      <div className="flex items-center gap-3 px-4 py-3">
        {currentView === 'discover' && (
          <div className="flex items-center rounded-lg border border-space-border overflow-hidden flex-shrink-0">
            <button
              onClick={() => handleSourceChange('ckan')}
              className={`px-3 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                discoverSource === 'ckan'
                  ? 'bg-[rgba(99,102,241,0.15)] text-[#c4b5fd]'
                  : 'bg-space-bg text-space-text-muted hover:text-white'
              }`}
            >
              CKAN
            </button>
            <button
              onClick={() => handleSourceChange('curseforge')}
              className={`px-3 py-2 text-xs font-semibold transition-colors cursor-pointer border-l border-space-border ${
                discoverSource === 'curseforge'
                  ? 'bg-[rgba(249,115,22,0.15)] text-[rgba(251,146,60,0.95)]'
                  : 'bg-space-bg text-space-text-muted hover:text-white'
              }`}
            >
              CurseForge
            </button>
          </div>
        )}

        {/* Search input */}
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-space-text-muted text-sm select-none">
            🔍
          </span>
          <input
            type="text"
            value={localQuery}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={discoverSource === 'curseforge'
              ? 'Search CurseForge KSP mods...'
              : 'Search mods... (author:name tag:parts license:MIT installed:yes)'}
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-space-bg border border-space-border text-space-text placeholder:text-space-text-muted text-sm focus:outline-none focus:border-space-accent/50 transition-colors"
          />
        </div>

        {/* Filter toggle */}
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border transition-colors cursor-pointer flex-shrink-0 ${
            showFilters || activeFilterCount > 0
              ? 'bg-[rgba(99,102,241,0.15)] border-[rgba(99,102,241,0.3)] text-[#a78bfa]'
              : 'bg-space-bg border-space-border text-space-text-muted hover:border-space-accent/30'
          }`}
        >
          Filters
          {activeFilterCount > 0 && (
            <span className="bg-[#6366f1] text-white text-[10px] w-4 h-4 rounded-full flex items-center justify-center font-bold">
              {activeFilterCount}
            </span>
          )}
        </button>

        {/* Sort dropdown */}
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as any)}
          className="select-dark"
        >
          <option value="downloads">Most Downloaded</option>
          <option value="name">Name A-Z</option>
          <option value="updated">Recently Updated</option>
        </select>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="px-4 pb-3 flex flex-col gap-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {discoverSource === 'ckan' ? (
              <>
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-space-text">CKAN Filter</label>
                  <select
                    value={ckanStateFilter}
                    onChange={(e) => setCkanStateFilter(e.target.value as any)}
                    className="select-dark"
                  >
                    <option value="all">All</option>
                    <option value="compatible">Compatible</option>
                    <option value="installed">Installed</option>
                    <option value="installedUpdateAvailable">Installed Update Available</option>
                    <option value="newInRepository">New in Repository</option>
                    <option value="notInstalled">Not Installed</option>
                    <option value="incompatible">Incompatible</option>
                    <option value="cached">Cached</option>
                    <option value="replaceable">Replaceable</option>
                    <option value="uncached">Uncached</option>
                    <option value="customLabel">Custom Label</option>
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-space-text">Tags</label>
                  <div className="grid grid-cols-2 gap-2 max-h-60 overflow-y-auto border border-space-border rounded-lg p-2 bg-space-bg">
                    {CKAN_TAG_OPTIONS.map((tag) => (
                      <label key={tag} className="flex items-center gap-2 text-[13px] text-space-text">
                        <input
                          type="checkbox"
                          checked={ckanTags.includes(tag)}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...ckanTags, tag]
                              : ckanTags.filter((value) => value !== tag)
                            setCkanTags(next)
                          }}
                          className="accent-[#6366f1]"
                        />
                        {tag}
                      </label>
                    ))}
                  </div>
                  <input
                    type="text"
                    value={ckanCustomLabel}
                    onChange={(e) => setCkanCustomLabel(e.target.value)}
                    placeholder="Custom label text"
                    className="input-dark"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-space-text">Browse By</label>
                  <select
                    value={curseForgeBrowseBy}
                    onChange={(e) => setCurseForgeBrowseBy(e.target.value as any)}
                    className="select-dark"
                  >
                    <option value="all">All</option>
                    <option value="missions">Missions</option>
                    <option value="shareables">Shareables</option>
                    <option value="mods">Mods</option>
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-semibold text-space-text">Category</label>
                  <select
                    value={curseForgeCategory}
                    onChange={(e) => setCurseForgeCategory(e.target.value as any)}
                    className="select-dark"
                  >
                    <option value="all">All Categories</option>
                    <option value="Command and Control">Command and Control</option>
                    <option value="Gameplay">Gameplay</option>
                    <option value="Miscellaneous">Miscellaneous</option>
                    <option value="Parts Pack">Parts Pack</option>
                    <option value="Physics">Physics</option>
                    <option value="Propulsion">Propulsion</option>
                    <option value="Resources">Resources</option>
                    <option value="Science">Science</option>
                    <option value="Ship Systems">Ship Systems</option>
                    <option value="Structural and Aerodynamic">Structural and Aerodynamic</option>
                    <option value="Sub-Assembly">Sub-Assembly</option>
                    <option value="Twitch Integration">Twitch Integration</option>
                    <option value="Utility and Navigation">Utility and Navigation</option>
                  </select>
                </div>
              </>
            )}
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="text-xs text-space-text-muted">
              Use these source-specific filters to narrow the Discover results.
            </div>
            {activeFilterCount > 0 && (
              <button
                onClick={() => {
                  resetFilters()
                  clearAdvancedFilters()
                  setCkanTags([])
                  setCkanStateFilter('all')
                  setCkanCustomLabel('')
                  setCurseForgeBrowseBy('all')
                  setCurseForgeCategory('all')
                }}
                className="text-xs text-[#ef4444] hover:text-[#f87171] transition-colors cursor-pointer"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
