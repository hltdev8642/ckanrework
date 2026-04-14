import type { ModVersionRow, Relationship } from '../types'
import type { DatabaseService } from './database'

export interface ResolvedMod {
  identifier: string
  version: string
  ksp_version: string | null
  download_url: string
  download_size: number | null
  download_hash: string | null
  install_directives: string
  isDependency: boolean
}

export interface ResolutionResult {
  success: boolean
  toInstall: ResolvedMod[]
  conflicts: string[]
  missing: string[]
  warnings: string[]
}

export class ResolverService {
  private db: DatabaseService

  constructor(db: DatabaseService) {
    this.db = db
  }

  resolve(identifiers: string[], kspVersion: string, profileId?: string): ResolutionResult {
    const toInstall = new Map<string, ResolvedMod>()
    const conflicts: string[] = []
    const missing: string[] = []
    const warnings: string[] = []
    const visited = new Set<string>()

    const installed = new Set<string>()
    if (profileId) {
      for (const mod of this.db.getInstalledMods(profileId)) {
        installed.add(mod.identifier)
      }
    }

    // Build provider map: virtual package name -> list of mod identifiers that provide it
    const providerMap = this.buildProviderMap()

    for (const id of identifiers) {
      this.resolveOne(id, kspVersion, toInstall, conflicts, missing, warnings, visited, installed, false, providerMap)
    }

    const allMods = [...toInstall.values()]
    for (const mod of allMods) {
      const versions = this.db.getModVersions(mod.identifier)
      const ver = versions.find(v => v.version === mod.version)
      if (!ver?.conflicts) continue
      const modConflicts: Relationship[] = JSON.parse(ver.conflicts)
      for (const conflict of modConflicts) {
        if (toInstall.has(conflict.name) || installed.has(conflict.name)) {
          conflicts.push(`${mod.identifier} conflicts with ${conflict.name}`)
        }
      }
    }

    // Only real conflicts block installation. Missing deps and version warnings are non-blocking.
    return { success: conflicts.length === 0, toInstall: allMods, conflicts, missing, warnings }
  }

  private buildProviderMap(): Map<string, string[]> {
    const map = new Map<string, string[]>()
    try {
      const rows = this.db.getModVersionsWithProvides()
      for (const row of rows) {
        let provides: string[]
        try { provides = JSON.parse(row.provides) } catch { continue }
        for (const virtualName of provides) {
          if (!map.has(virtualName)) map.set(virtualName, [])
          const list = map.get(virtualName)!
          if (!list.includes(row.identifier)) list.push(row.identifier)
        }
      }
    } catch { /* ignore provider map build errors */ }
    return map
  }

  private resolveOne(
    identifier: string, kspVersion: string,
    toInstall: Map<string, ResolvedMod>, conflicts: string[], missing: string[],
    warnings: string[], visited: Set<string>, installed: Set<string>,
    isDependency: boolean, providerMap: Map<string, string[]>,
    constraint?: Relationship
  ) {
    if (visited.has(identifier)) return
    visited.add(identifier)
    if (installed.has(identifier)) return
    if (toInstall.has(identifier)) return

    const versions = this.db.getModVersions(identifier)

    if (versions.length === 0) {
      // Check if a virtual package is provided by another mod
      const providers = providerMap.get(identifier)
      if (providers && providers.length > 0) {
        for (const provider of providers) {
          if (!installed.has(provider) && !toInstall.has(provider)) {
            this.resolveOne(provider, kspVersion, toInstall, conflicts, missing, warnings, visited, installed, isDependency, providerMap)
            return
          }
        }
        // A suitable provider is already installed/queued — dependency satisfied
        return
      }

      if (isDependency) {
        warnings.push(`${identifier}: no downloadable version found (may be a virtual package provided by another mod)`)
      } else {
        missing.push(identifier)
      }
      return
    }

    const selected = this.selectVersion(versions, kspVersion, constraint)
    if (!selected) {
      if (isDependency) {
        warnings.push(`${identifier}: no version satisfying constraints found`)
      } else {
        missing.push(identifier)
      }
      return
    }

    const compatible = this.findCompatibleVersion(versions, kspVersion)
    if (!compatible) {
      warnings.push(`${identifier} v${selected.version} may not be compatible with KSP ${kspVersion}`)
    }

    toInstall.set(identifier, {
      identifier, version: selected.version,
      ksp_version: selected.ksp_version ?? selected.ksp_version_min ?? selected.ksp_version_max ?? null,
      download_url: selected.download_url,
      download_size: selected.download_size, download_hash: selected.download_hash,
      install_directives: selected.install_directives, isDependency
    })

    if (selected.depends) {
      const deps: Relationship[] = JSON.parse(selected.depends)
      for (const dep of deps) {
        this.resolveOne(dep.name, kspVersion, toInstall, conflicts, missing, warnings, visited, installed, true, providerMap, dep)
      }
    }

    // Recommends: install if the mod exists in our registry and isn't already present
    if (selected.recommends) {
      try {
        const recs: Relationship[] = JSON.parse(selected.recommends)
        for (const rec of recs) {
          if (!installed.has(rec.name) && !toInstall.has(rec.name) && !visited.has(rec.name)) {
            const recVersions = this.db.getModVersions(rec.name)
            if (recVersions.length > 0) {
              this.resolveOne(rec.name, kspVersion, toInstall, conflicts, missing, warnings, visited, installed, true, providerMap, rec)
            }
          }
        }
      } catch { /* ignore recommends parse errors */ }
    }
  }

  /**
   * Select the best version satisfying both KSP compatibility and relationship version constraints.
   * Versions are already sorted descending (highest first).
   */
  private selectVersion(versions: ModVersionRow[], kspVersion: string, constraint?: Relationship): ModVersionRow | null {
    let candidates = versions.filter(v => this.isKspCompatible(v, kspVersion))
    if (candidates.length === 0) candidates = [...versions] // fallback: any version

    if (constraint?.version) {
      const exact = candidates.find(v => v.version === constraint.version)
        ?? versions.find(v => v.version === constraint.version)
      return exact ?? null
    }

    if (constraint?.min_version) {
      const minParts = this.parseVersion(constraint.min_version) ?? []
      candidates = candidates.filter(v =>
        this.compareVersions(this.parseVersion(v.version) ?? [], minParts) >= 0
      )
    }
    if (constraint?.max_version) {
      const maxParts = this.parseVersion(constraint.max_version) ?? []
      candidates = candidates.filter(v =>
        this.compareVersions(this.parseVersion(v.version) ?? [], maxParts) <= 0
      )
    }

    return candidates[0] ?? null  // highest compatible version
  }

  private findCompatibleVersion(versions: ModVersionRow[], kspVersion: string): ModVersionRow | null {
    for (const v of versions) {
      if (this.isKspCompatible(v, kspVersion)) return v
    }
    return null
  }

  private isKspCompatible(version: ModVersionRow, kspVersion: string): boolean {
    if (version.ksp_version === 'any') return true
    if (!version.ksp_version && !version.ksp_version_min && !version.ksp_version_max) return true

    const target = this.parseVersion(kspVersion)
    if (!target) return true

    if (version.ksp_version) {
      if (version.ksp_version === kspVersion) return true
      const mod = this.parseVersion(version.ksp_version)
      // Match on major.minor (KSP 1.x convention allows minor compatibility)
      if (mod && mod[0] === target[0] && mod[1] === target[1]) return true
      return false
    }

    if (version.ksp_version_min) {
      const min = this.parseVersion(version.ksp_version_min)
      if (min && this.compareVersions(target, min) < 0) return false
    }
    if (version.ksp_version_max) {
      const max = this.parseVersion(version.ksp_version_max)
      if (max && this.compareVersions(target, max) > 0) return false
    }
    return true
  }

  /** Parse version string to numeric parts; strips 'v' prefix; treats non-numeric segments as 0. */
  private parseVersion(v: string): number[] | null {
    if (!v) return null
    const cleaned = v.replace(/^v/i, '')
    const parts = cleaned.split('.').map(p => { const n = parseInt(p, 10); return isNaN(n) ? 0 : n })
    return parts.length > 0 ? parts : null
  }

  private compareVersions(a: number[], b: number[]): number {
    const len = Math.max(a.length, b.length)
    for (let i = 0; i < len; i++) {
      const av = a[i] ?? 0
      const bv = b[i] ?? 0
      if (av !== bv) return av - bv
    }
    return 0
  }
}
