import { useEffect, useRef, useState } from 'react'
import { useUiStore, type AdvancedFilters } from '../../stores/ui-store'
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

export function SearchBar() {
  const {
    currentView, discoverSource, searchQuery, sortBy, setSearchQuery, setSortBy,
    resetFilters, advancedFilters,
    setAdvancedFilters, clearAdvancedFilters, setDiscoverSource,
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
    (advancedFilters.compat ? 1 : 0)

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
        <div className="px-4 pb-3 flex items-center gap-4 flex-wrap">
          {activeFilterCount > 0 && (
            <button
              onClick={() => { resetFilters(); clearAdvancedFilters() }}
              className="text-xs text-[#ef4444] hover:text-[#f87171] transition-colors cursor-pointer ml-auto"
            >
              Reset
            </button>
          )}
        </div>
      )}
    </div>
  )
}
