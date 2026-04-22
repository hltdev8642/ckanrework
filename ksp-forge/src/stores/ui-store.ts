import { create } from 'zustand'

export type ViewName = 'discover' | 'installed' | 'downloads' | 'profiles' | 'settings' | 'mod-detail' | 'audit'
export type DiscoverSource = 'ckan' | 'curseforge'

export interface AdvancedFilters {
  author: string
  tag: string
  license: string
  installed: '' | 'yes' | 'no'
  compat: string
}

export type CkanDiscoverFilter =
  | 'all'
  | 'compatible'
  | 'installed'
  | 'installedUpdateAvailable'
  | 'newInRepository'
  | 'notInstalled'
  | 'incompatible'
  | 'cached'
  | 'replaceable'
  | 'uncached'
  | 'customLabel'

export type CurseForgeBrowseBy = 'all' | 'missions' | 'shareables' | 'mods'
export type CurseForgeCategory =
  | 'all'
  | 'Command and Control'
  | 'Gameplay'
  | 'Miscellaneous'
  | 'Parts Pack'
  | 'Physics'
  | 'Propulsion'
  | 'Resources'
  | 'Science'
  | 'Ship Systems'
  | 'Structural and Aerodynamic'
  | 'Sub-Assembly'
  | 'Twitch Integration'
  | 'Utility and Navigation'

interface FilterState {
  sortBy: 'name' | 'downloads' | 'updated'
  filterKspVersionMin: string
  filterKspVersionMax: string
  filterCompatibleOnly: boolean
  concurrentDownloads: number
  ckanStateFilter: CkanDiscoverFilter
  ckanTags: string[]
  ckanCustomLabel: string
  curseForgeBrowseBy: CurseForgeBrowseBy
  curseForgeCategory: CurseForgeCategory
}

const FILTERS_KEY = 'ksp-forge-filters'

function loadFilters(): FilterState {
  const defaults: FilterState = {
    sortBy: 'downloads',
    filterKspVersionMin: '',
    filterKspVersionMax: '',
    filterCompatibleOnly: false,
    concurrentDownloads: 1,
    ckanStateFilter: 'all',
    ckanTags: [],
    ckanCustomLabel: '',
    curseForgeBrowseBy: 'all',
    curseForgeCategory: 'all',
  }

  try {
    const raw = localStorage.getItem(FILTERS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FilterState>
      return { ...defaults, ...parsed, ckanTags: parsed.ckanTags ?? [] }
    }
  } catch { /* ignore */ }
  return defaults
}

function saveFilters(f: FilterState) {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(f)) } catch { /* ignore */ }
}

interface UiState extends FilterState {
  currentView: ViewName
  previousView: ViewName | null
  discoverSource: DiscoverSource
  selectedModId: string | null
  searchQuery: string
  discoverScrollPosition: number
  advancedFilters: AdvancedFilters

  setView: (view: ViewName) => void
  setDiscoverSource: (source: DiscoverSource) => void
  setSelectedMod: (id: string | null) => void
  setSearchQuery: (query: string) => void
  setSortBy: (sort: 'name' | 'downloads' | 'updated') => void
  setFilterKspVersionMin: (v: string) => void
  setFilterKspVersionMax: (v: string) => void
  setFilterCompatibleOnly: (v: boolean) => void
  setConcurrentDownloads: (n: number) => void
  setCkanStateFilter: (filter: CkanDiscoverFilter) => void
  setCkanCustomLabel: (label: string) => void
  setCurseForgeBrowseBy: (browseBy: CurseForgeBrowseBy) => void
  setCurseForgeCategory: (category: CurseForgeCategory) => void
  resetFilters: () => void
  openModDetail: (id: string) => void
  goBack: () => void
  setDiscoverScrollPosition: (pos: number) => void
  setCkanTags: (tags: string[]) => void
  setAdvancedFilters: (filters: Partial<AdvancedFilters>) => void
  clearAdvancedFilters: () => void
}

const savedFilters = loadFilters()

export const useUiStore = create<UiState>((set, get) => ({
  currentView: 'discover',
  previousView: null,
  discoverSource: 'ckan',
  selectedModId: null,
  searchQuery: '',
  discoverScrollPosition: 0,
  advancedFilters: { author: '', tag: '', license: '', installed: '', compat: '' },
  ckanTags: [],
  ...savedFilters,

  setView: (view) =>
    set((state) => ({
      currentView: view,
      previousView: state.currentView,
    })),

  setDiscoverSource: (source) => set({ discoverSource: source, searchQuery: '' }),

  setSelectedMod: (id) => set({ selectedModId: id }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  setSortBy: (sort) => {
    set({ sortBy: sort })
    const s = get()
    saveFilters({
      sortBy: sort,
      filterKspVersionMin: s.filterKspVersionMin,
      filterKspVersionMax: s.filterKspVersionMax,
      filterCompatibleOnly: s.filterCompatibleOnly,
      concurrentDownloads: s.concurrentDownloads,
      ckanStateFilter: s.ckanStateFilter,
      ckanTags: s.ckanTags,
      ckanCustomLabel: s.ckanCustomLabel,
      curseForgeBrowseBy: s.curseForgeBrowseBy,
      curseForgeCategory: s.curseForgeCategory,
    })
  },

  setFilterKspVersionMin: (v) => {
    set({ filterKspVersionMin: v })
    const s = get()
    saveFilters({
      sortBy: s.sortBy,
      filterKspVersionMin: v,
      filterKspVersionMax: s.filterKspVersionMax,
      filterCompatibleOnly: s.filterCompatibleOnly,
      concurrentDownloads: s.concurrentDownloads,
      ckanStateFilter: s.ckanStateFilter,
      ckanTags: s.ckanTags,
      ckanCustomLabel: s.ckanCustomLabel,
      curseForgeBrowseBy: s.curseForgeBrowseBy,
      curseForgeCategory: s.curseForgeCategory,
    })
  },

  setFilterKspVersionMax: (v) => {
    set({ filterKspVersionMax: v })
    const s = get()
    saveFilters({
      sortBy: s.sortBy,
      filterKspVersionMin: s.filterKspVersionMin,
      filterKspVersionMax: v,
      filterCompatibleOnly: s.filterCompatibleOnly,
      concurrentDownloads: s.concurrentDownloads,
      ckanStateFilter: s.ckanStateFilter,
      ckanTags: s.ckanTags,
      ckanCustomLabel: s.ckanCustomLabel,
      curseForgeBrowseBy: s.curseForgeBrowseBy,
      curseForgeCategory: s.curseForgeCategory,
    })
  },

  setFilterCompatibleOnly: (v) => {
    set({ filterCompatibleOnly: v })
    const s = get()
    saveFilters({
      sortBy: s.sortBy,
      filterKspVersionMin: s.filterKspVersionMin,
      filterKspVersionMax: s.filterKspVersionMax,
      filterCompatibleOnly: v,
      concurrentDownloads: s.concurrentDownloads,
      ckanStateFilter: s.ckanStateFilter,
      ckanTags: s.ckanTags,
      ckanCustomLabel: s.ckanCustomLabel,
      curseForgeBrowseBy: s.curseForgeBrowseBy,
      curseForgeCategory: s.curseForgeCategory,
    })
  },

  setConcurrentDownloads: (n) => {
    const clamped = Math.max(1, Math.min(5, n))
    set({ concurrentDownloads: clamped })
    const s = get()
    saveFilters({
      sortBy: s.sortBy,
      filterKspVersionMin: s.filterKspVersionMin,
      filterKspVersionMax: s.filterKspVersionMax,
      filterCompatibleOnly: s.filterCompatibleOnly,
      concurrentDownloads: clamped,
      ckanStateFilter: s.ckanStateFilter,
      ckanTags: s.ckanTags,
      ckanCustomLabel: s.ckanCustomLabel,
      curseForgeBrowseBy: s.curseForgeBrowseBy,
      curseForgeCategory: s.curseForgeCategory,
    })
  },

  setCkanStateFilter: (filter) => {
    set({ ckanStateFilter: filter })
    const s = get()
    saveFilters({
      sortBy: s.sortBy,
      filterKspVersionMin: s.filterKspVersionMin,
      filterKspVersionMax: s.filterKspVersionMax,
      filterCompatibleOnly: s.filterCompatibleOnly,
      concurrentDownloads: s.concurrentDownloads,
      ckanStateFilter: filter,
      ckanCustomLabel: s.ckanCustomLabel,
      curseForgeBrowseBy: s.curseForgeBrowseBy,
      curseForgeCategory: s.curseForgeCategory,
    })
  },

  setCkanCustomLabel: (label) => {
    set({ ckanCustomLabel: label })
    const s = get()
    saveFilters({
      sortBy: s.sortBy,
      filterKspVersionMin: s.filterKspVersionMin,
      filterKspVersionMax: s.filterKspVersionMax,
      filterCompatibleOnly: s.filterCompatibleOnly,
      concurrentDownloads: s.concurrentDownloads,
      ckanStateFilter: s.ckanStateFilter,
      ckanCustomLabel: label,
      curseForgeBrowseBy: s.curseForgeBrowseBy,
      curseForgeCategory: s.curseForgeCategory,
    })
  },

  setCurseForgeBrowseBy: (browseBy) => {
    set({ curseForgeBrowseBy: browseBy })
    const s = get()
    saveFilters({
      sortBy: s.sortBy,
      filterKspVersionMin: s.filterKspVersionMin,
      filterKspVersionMax: s.filterKspVersionMax,
      filterCompatibleOnly: s.filterCompatibleOnly,
      concurrentDownloads: s.concurrentDownloads,
      ckanStateFilter: s.ckanStateFilter,
      ckanCustomLabel: s.ckanCustomLabel,
      curseForgeBrowseBy: browseBy,
      curseForgeCategory: s.curseForgeCategory,
    })
  },

  setCurseForgeCategory: (category) => {
    set({ curseForgeCategory: category })
    const s = get()
    saveFilters({
      sortBy: s.sortBy,
      filterKspVersionMin: s.filterKspVersionMin,
      filterKspVersionMax: s.filterKspVersionMax,
      filterCompatibleOnly: s.filterCompatibleOnly,
      concurrentDownloads: s.concurrentDownloads,
      ckanStateFilter: s.ckanStateFilter,
      ckanTags: s.ckanTags,
      ckanCustomLabel: s.ckanCustomLabel,
      curseForgeBrowseBy: s.curseForgeBrowseBy,
      curseForgeCategory: category,
    })
  },

  setCkanTags: (tags) => {
    set({ ckanTags: tags })
    const s = get()
    saveFilters({
      sortBy: s.sortBy,
      filterKspVersionMin: s.filterKspVersionMin,
      filterKspVersionMax: s.filterKspVersionMax,
      filterCompatibleOnly: s.filterCompatibleOnly,
      concurrentDownloads: s.concurrentDownloads,
      ckanStateFilter: s.ckanStateFilter,
      ckanTags: tags,
      ckanCustomLabel: s.ckanCustomLabel,
      curseForgeBrowseBy: s.curseForgeBrowseBy,
      curseForgeCategory: s.curseForgeCategory,
    })
  },

  resetFilters: () => {
    const defaults: FilterState = {
      sortBy: 'downloads',
      filterKspVersionMin: '',
      filterKspVersionMax: '',
      filterCompatibleOnly: false,
      concurrentDownloads: 1,
      ckanStateFilter: 'all',
      ckanCustomLabel: '',
      curseForgeBrowseBy: 'all',
      curseForgeCategory: 'all',
    }
    set({ searchQuery: '', ...defaults })
    saveFilters(defaults)
  },

  openModDetail: (id) =>
    set((state) => ({
      selectedModId: id,
      currentView: 'mod-detail',
      previousView: state.currentView,
    })),

  goBack: () => {
    const { previousView } = get()
    set({
      currentView: previousView ?? 'discover',
      previousView: null,
    })
  },

  setDiscoverScrollPosition: (pos) => set({ discoverScrollPosition: pos }),

  setAdvancedFilters: (filters) =>
    set(s => ({ advancedFilters: { ...s.advancedFilters, ...filters } })),

  clearAdvancedFilters: () =>
    set({ advancedFilters: { author: '', tag: '', license: '', installed: '', compat: '' } }),
}))
