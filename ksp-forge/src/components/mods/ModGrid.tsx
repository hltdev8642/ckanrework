import { useEffect, useRef, useMemo, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useModStore } from '../../stores/mod-store'
import { useProfileStore } from '../../stores/profile-store'
import { useUiStore } from '../../stores/ui-store'
import { SearchBar } from '../layout/SearchBar'
import { ModCard } from './ModCard'
import { InstallDialog } from '../install/InstallDialog'
import { useInstallStore } from '../../stores/install-store'

interface ModGridProps {
  filter?: 'all' | 'installed'
}

const CARD_HEIGHT = 220
const GAP = 16

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va !== vb) return va - vb
  }
  return 0
}

function getModKspVersion(mod: { ksp_version: string | null; ksp_version_min: string | null; ksp_version_max: string | null }): string {
  return mod.ksp_version || mod.ksp_version_min || mod.ksp_version_max || ''
}

export function ModGrid({ filter = 'all' }: ModGridProps) {
  const { mods, loading, fetchSpaceDockBatch, spacedockCache } = useModStore()
  const { installedMods, activeProfileId, fetchInstalledMods, uninstallMod } = useProfileStore()
  const { currentView, discoverScrollPosition, setDiscoverScrollPosition, openModDetail, sortBy, advancedFilters, searchQuery } = useUiStore()
  const { getActiveProfile } = useProfileStore()
  const { resolution, showDialog, installing, progress, confirmInstall, cancelInstall, requestInstall } = useInstallStore()
  const parentRef = useRef<HTMLDivElement>(null)
  const scrollRestoredRef = useRef(false)

  const handleCardInstall = useCallback((identifier: string) => {
    requestInstall([identifier])
  }, [requestInstall])

  // Save scroll position before navigating to mod detail
  const handleOpenModDetail = useCallback((id: string) => {
    if (parentRef.current) {
      setDiscoverScrollPosition(parentRef.current.scrollTop)
    }
    openModDetail(id)
  }, [openModDetail, setDiscoverScrollPosition])

  // Restore scroll position when component mounts (coming back from mod detail)
  useEffect(() => {
    if (!scrollRestoredRef.current && parentRef.current && discoverScrollPosition > 0) {
      scrollRestoredRef.current = true
      // Use rAF to ensure the virtualizer has rendered before scrolling
      requestAnimationFrame(() => {
        if (parentRef.current) {
          parentRef.current.scrollTop = discoverScrollPosition
        }
      })
    }
  }, [])

  const isInstalledView = currentView === 'installed' || filter === 'installed'

  // Build set of installed mods that have an update available
  const updatesAvailableSet = useMemo(() => {
    const set = new Set<string>()
    for (const im of installedMods) {
      const modRow = mods.find(m => m.identifier === im.identifier)
      if (modRow && modRow.latest_version && modRow.latest_version !== im.version) {
        set.add(im.identifier)
      }
    }
    return set
  }, [installedMods, mods])

  // Compute incompatible mods for the installed view badge (display hint only, not a filter)
  const activeProfile = getActiveProfile()
  const incompatibleSet = useMemo(() => {
    const set = new Set<string>()
    if (!activeProfile || activeProfile.ksp_version === 'unknown') return set
    const pv = activeProfile.ksp_version
    for (const m of mods) {
      if (!installedMods.some(im => im.identifier === m.identifier)) continue
      if (m.ksp_version === 'any' || (!m.ksp_version && !m.ksp_version_min && !m.ksp_version_max)) continue
      if (m.ksp_version) {
        const mp = m.ksp_version.split('.')
        const pp = pv.split('.')
        if (mp[0] !== pp[0] || mp[1] !== pp[1]) set.add(m.identifier)
      } else {
        if (m.ksp_version_min && compareVersions(pv, m.ksp_version_min) < 0) set.add(m.identifier)
        if (m.ksp_version_max && compareVersions(pv, m.ksp_version_max) > 0) set.add(m.identifier)
      }
    }
    return set
  }, [mods, installedMods, activeProfile?.ksp_version])

  useEffect(() => {
    if (activeProfileId) fetchInstalledMods(activeProfileId)
  }, [activeProfileId])

  const installedSet = useMemo(
    () => new Set(installedMods.map((m) => m.identifier)),
    [installedMods]
  )

  const displayedMods = useMemo(() => {
    let result = isInstalledView
      ? mods.filter((m) => installedSet.has(m.identifier))
      : [...mods]

    // Advanced filters (always applied)
    if (advancedFilters.author) {
      const a = advancedFilters.author.toLowerCase()
      result = result.filter(m => m.author?.toLowerCase().includes(a))
    }
    if (advancedFilters.tag) {
      const t = advancedFilters.tag.toLowerCase()
      result = result.filter(m => {
        if (!m.tags) return false
        try { return (JSON.parse(m.tags) as string[]).some(tag => tag.toLowerCase().includes(t)) } catch { return false }
      })
    }
    if (advancedFilters.license) {
      const l = advancedFilters.license.toLowerCase()
      result = result.filter(m => m.license?.toLowerCase().includes(l))
    }
    if (advancedFilters.installed === 'yes') {
      result = result.filter(m => installedSet.has(m.identifier))
    } else if (advancedFilters.installed === 'no') {
      result = result.filter(m => !installedSet.has(m.identifier))
    }
    if (advancedFilters.compat) {
      const cv = advancedFilters.compat
      result = result.filter(m => {
        if (m.ksp_version === 'any' || (!m.ksp_version && !m.ksp_version_min && !m.ksp_version_max)) return true
        if (m.ksp_version) {
          return m.ksp_version.startsWith(cv.slice(0, cv.length >= 3 ? 3 : cv.length))
        }
        return true
      })
    }

    // Sort
    if (sortBy === 'name') {
      result = [...result].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    } else if (sortBy === 'updated') {
      result = [...result].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
    }
    // 'downloads' = default DB order (no sort needed)

    return result
  }, [mods, isInstalledView, installedSet, sortBy, advancedFilters, searchQuery])

  const containerWidth = parentRef.current?.clientWidth ?? 900
  const columns = Math.max(1, Math.floor((containerWidth + GAP) / (240 + GAP)))
  const rowCount = Math.ceil(displayedMods.length / columns)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => CARD_HEIGHT + GAP,
    overscan: 3,
  })

  // Batch-prefetch SpaceDock data for visible cards
  const prefetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const visibleItems = virtualizer.getVirtualItems()

  useEffect(() => {
    if (prefetchTimeoutRef.current) clearTimeout(prefetchTimeoutRef.current)
    prefetchTimeoutRef.current = setTimeout(() => {
      const ids: string[] = []
      for (const row of visibleItems) {
        const start = row.index * columns
        const rowMods = displayedMods.slice(start, start + columns)
        for (const m of rowMods) {
          if (m.spacedock_id && !spacedockCache.has(m.identifier)) {
            ids.push(m.identifier)
          }
        }
      }
      if (ids.length > 0) fetchSpaceDockBatch(ids)
    }, 150) // debounce scroll
  }, [visibleItems.length > 0 ? visibleItems[0]?.index : -1, columns])

  const title = isInstalledView ? 'Installed Mods' : 'Discover Mods'

  return (
    <div className="flex flex-col h-full">
      <SearchBar />

      <div ref={parentRef} className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="mb-4 flex items-center justify-between pt-4">
          <h2 className="text-2xl font-bold text-white">{title}</h2>
          {!loading && (
            <span className="text-sm text-[rgba(148,163,184,0.6)]">
              {displayedMods.length} mod{displayedMods.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {loading && (
          <div className="flex items-center justify-center py-20">
            <p className="text-[rgba(99,102,241,0.9)] font-medium animate-pulse">Loading mods...</p>
          </div>
        )}

        {!loading && displayedMods.length === 0 && (
          <div className="flex items-center justify-center py-20 text-center">
            <div>
              <p className="text-[rgba(148,163,184,0.7)] text-lg font-medium">
                {isInstalledView ? 'No mods installed yet' : 'No mods found'}
              </p>
              <p className="text-[rgba(100,116,139,0.7)] text-sm mt-1">
                {isInstalledView ? 'Browse the Discover tab to find and install mods' : 'Try adjusting your search or filters'}
              </p>
            </div>
          </div>
        )}

        {!loading && displayedMods.length > 0 && (
          <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const startIndex = virtualRow.index * columns
              const rowMods = displayedMods.slice(startIndex, startIndex + columns)
              return (
                <div
                  key={virtualRow.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: CARD_HEIGHT,
                    transform: `translateY(${virtualRow.start}px)`,
                    display: 'grid',
                    gridTemplateColumns: `repeat(${columns}, 1fr)`,
                    gap: `${GAP}px`,
                  }}
                >
                  {rowMods.map((mod) => (
                    <ModCard
                      key={mod.identifier}
                      mod={mod}
                      isInstalled={installedSet.has(mod.identifier)}
                      incompatible={incompatibleSet.has(mod.identifier)}
                      hasUpdate={updatesAvailableSet.has(mod.identifier)}
                      onInstall={handleCardInstall}
                      onOpenDetail={handleOpenModDetail}
                      onUninstall={isInstalledView ? () => uninstallMod(mod.identifier) : undefined}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {showDialog && resolution && (
        <InstallDialog resolution={resolution} onConfirm={confirmInstall} onCancel={cancelInstall} />
      )}
    </div>
  )
}
