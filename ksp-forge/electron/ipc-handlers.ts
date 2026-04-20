import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import fs from 'fs'
import type { CurseForgeInstallCandidate, SpaceDockCacheRow } from './types'
import type { ImageScraperService } from './services/image-scraper'
import type { DatabaseService } from './services/database'
import type { MetaSyncService } from './services/meta-sync'
import type { SpaceDockService } from './services/spacedock'
import type { ResolverService } from './services/resolver'
import type { InstallerService } from './services/installer'
import type { ProfileService } from './services/profile'
import type { ModCacheService } from './services/mod-cache'
import type { CurseForgeService } from './services/curseforge'
import { getLogger } from './services/logger'
import os from 'os'
import path from 'path'

interface Services {
  db: DatabaseService
  metaSync: MetaSyncService
  spaceDock: SpaceDockService
  resolver: ResolverService
  installer: InstallerService
  profile: ProfileService
  imageScraper: ImageScraperService
  modCache: ModCacheService
  curseForge: CurseForgeService
}

export function registerIpcHandlers(services: Services): void {
  const { db, metaSync, spaceDock, resolver, installer, profile, imageScraper, modCache, curseForge } = services
  const log = getLogger()

  // --- Mods ---
  ipcMain.handle('mods:getAll', () => {
    return db.getAllMods()
  })

  ipcMain.handle('mods:get', (_event, identifier: string) => {
    return db.getMod(identifier) ?? null
  })

  ipcMain.handle('mods:search', (_event, query: string) => {
    return db.searchMods(query)
  })

  ipcMain.handle('mods:getVersions', (_event, identifier: string) => {
    return db.getModVersions(identifier)
  })

  ipcMain.handle('mods:getCount', () => {
    return db.getModCount()
  })

  ipcMain.handle('mods:kspVersions', () => {
    return db.getDistinctKspVersions()
  })

  ipcMain.handle('curseforge:search', async (_event, query: string) => {
    return curseForge.searchMods(query)
  })

  ipcMain.handle('curseforge:getDetail', async (_event, identifier: string) => {
    return curseForge.getProjectDetail(identifier)
  })

  ipcMain.handle('curseforge:prepareInstall', async (_event, mod: any) => {
    return curseForge.prepareInstall(mod)
  })

  ipcMain.handle('settings:get', (_event, key: string) => {
    return db.getSetting(key)
  })

  ipcMain.handle('settings:set', (_event, key: string, value: string) => {
    db.setSetting(key, value)
    return { success: true }
  })

  // --- SpaceDock ---
  ipcMain.handle('spacedock:fetch', (_event, identifier: string) => {
    return spaceDock.fetchModData(identifier)
  })

  ipcMain.handle('spacedock:getCachedImageUrl', async (_event, identifier: string) => {
    return spaceDock.getCachedImageUrl(identifier)
  })

  ipcMain.handle('spacedock:fetchBatch', async (_event, identifiers: string[]) => {
    const map = await spaceDock.fetchBatch(identifiers)
    // Convert Map to plain object for IPC serialization
    const obj: Record<string, SpaceDockCacheRow> = {}
    for (const [k, v] of map) obj[k] = v
    return obj
  })

  // --- Image Scraper ---
  ipcMain.handle('images:scrape', async (_event, identifier: string) => {
    return imageScraper.scrapeModImages(identifier)
  })

  ipcMain.handle('images:forumDescription', async (_event, identifier: string) => {
    return imageScraper.scrapeForumDescription(identifier)
  })

  // Dedup map: identifier -> in-flight promise so concurrent card renders
  // don't each spawn their own BrowserWindow scrape.
  const firstForumImageInflight = new Map<string, Promise<string | null>>()

  ipcMain.handle('images:firstForumImage', async (_event, identifier: string) => {
    // Serve from memory cache immediately
    const cached = imageScraper.getCachedImages(identifier)
    if (cached && cached.length > 0) return cached[0]

    // Deduplicate concurrent requests for the same identifier
    if (firstForumImageInflight.has(identifier)) {
      return firstForumImageInflight.get(identifier)!
    }

    const promise = imageScraper.scrapeForumDescription(identifier).then(() => {
      const images = imageScraper.getCachedImages(identifier)
      return images && images.length > 0 ? images[0] : null
    }).finally(() => {
      firstForumImageInflight.delete(identifier)
    })

    firstForumImageInflight.set(identifier, promise)
    return promise
  })

  // --- Resolver ---
  ipcMain.handle('resolver:resolve', (_event, identifiers: string[], kspVersion: string, profileId?: string) => {
    return resolver.resolve(identifiers, kspVersion, profileId)
  })

  // --- Installer ---
  ipcMain.handle('installer:install', async (_event, resolvedMod: any, kspPath: string, profileId: string, isDependency?: boolean) => {
    log.info(`Installing mod: ${resolvedMod.identifier} v${resolvedMod.version} to profile ${profileId}`)
    const tempDir = path.join(os.tmpdir(), 'ksp-forge-install')
    const plan = installer.buildInstallPlan([resolvedMod])
    const item = plan[0]
    const { Worker } = require('worker_threads')

    const files: string[] = await new Promise((resolve, reject) => {
      const workerPath = path.join(__dirname, 'install-worker.js')
      const worker = new Worker(workerPath, {
        workerData: {
          identifier: item.identifier,
          version: item.version,
          downloadUrl: item.downloadUrl,
          hash: item.hash,
          directives: item.directives,
          kspPath,
          tempDir,
        }
      })

      const win = BrowserWindow.getFocusedWindow()
      worker.on('message', (msg: any) => {
        if (msg.type === 'done') { log.info(`Mod installed successfully: ${item.identifier}`); resolve(msg.files) }
        else if (msg.type === 'error') { log.error(`Mod install failed: ${item.identifier} - ${msg.message}`); reject(new Error(msg.message)) }
        else if (msg.type === 'download-progress' || msg.type === 'status') {
          win?.webContents.send('installer:progress', { identifier: item.identifier, ...msg })
        }
      })
      worker.on('error', reject)
    })

    if (resolvedMod.source === 'curseforge' && resolvedMod.metadata) {
      const metadata = resolvedMod.metadata as CurseForgeInstallCandidate
      db.upsertMod({
        identifier: metadata.identifier,
        name: metadata.name,
        abstract: metadata.abstract,
        author: metadata.author,
        license: metadata.license,
        latest_version: metadata.version,
        ksp_version: metadata.kspVersion,
        ksp_version_min: null,
        ksp_version_max: null,
        download_url: metadata.downloadUrl,
        download_size: metadata.downloadSize,
        spacedock_id: null,
        tags: metadata.tags.length > 0 ? JSON.stringify(metadata.tags) : null,
        resources: JSON.stringify({
          source: 'curseforge',
          homepage: metadata.projectUrl,
          curseforgeProjectUrl: metadata.projectUrl,
          curseforgeImageUrl: metadata.imageUrl,
          curseforgeDescriptionHtml: metadata.descriptionHtml,
          ...metadata.links,
        }),
        release_date: metadata.releaseDate,
        updated_at: Date.now(),
      })
      db.upsertModVersion({
        identifier: metadata.identifier,
        version: metadata.version,
        ksp_version: metadata.kspVersion,
        ksp_version_min: null,
        ksp_version_max: null,
        download_url: metadata.downloadUrl,
        download_hash: null,
        download_size: metadata.downloadSize,
        depends: null,
        recommends: null,
        suggests: null,
        conflicts: null,
        provides: null,
        install_directives: '[]',
      })
    }

    // Track in DB (main thread, fast)
    db.addInstalledMod({
      profile_id: profileId,
      identifier: item.identifier,
      version: item.version,
      installed_files: JSON.stringify(files),
      installed_at: Date.now(),
      is_dependency: isDependency ? 1 : 0,
    })

    // Cache mod files for future profile switches
    try {
      modCache.cacheModFiles(item.identifier, item.version, files, kspPath)
    } catch {
      // Non-fatal: caching failure should not break install
    }

    return { success: true }
  })

  ipcMain.handle('installer:uninstall', async (_event, profileId: string, identifier: string, kspPath: string) => {
    log.info(`Uninstalling mod: ${identifier} from profile ${profileId}`)
    await installer.uninstallMod(profileId, identifier, kspPath)
    log.info(`Mod uninstalled: ${identifier}`)
    return { success: true }
  })

  // --- Profiles ---
  ipcMain.handle('profiles:getAll', () => {
    return profile.getProfiles()
  })

  ipcMain.handle('profiles:get', (_event, id: string) => {
    return profile.getProfile(id) ?? null
  })

  ipcMain.handle('profiles:create', (_event, name: string, kspPath: string) => {
    return profile.createProfile(name, kspPath)
  })

  ipcMain.handle('profiles:delete', (_event, id: string) => {
    profile.deleteProfile(id)
    return { success: true }
  })

  ipcMain.handle('profiles:clone', (_event, sourceId: string, newName: string) => {
    return profile.cloneProfile(sourceId, newName)
  })

  ipcMain.handle('profiles:export', (_event, profileId: string) => {
    return profile.exportProfile(profileId)
  })

  ipcMain.handle('profiles:exportToFile', async (_event, profileId: string) => {
    const exportData = profile.exportProfile(profileId)
    const exportJson = {
      name: exportData.profile.name,
      ksp_version: exportData.profile.ksp_version,
      mods: exportData.mods.map((m) => ({ identifier: m.identifier, version: m.version })),
    }

    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showSaveDialog(win, {
          defaultPath: `${exportData.profile.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
      : await dialog.showSaveDialog({
          defaultPath: `${exportData.profile.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })

    if (result.canceled || !result.filePath) return { success: false }
    fs.writeFileSync(result.filePath, JSON.stringify(exportJson, null, 2), 'utf-8')
    return { success: true, path: result.filePath }
  })

  ipcMain.handle('profiles:importFromFile', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, {
          filters: [{ name: 'JSON', extensions: ['json'] }],
          properties: ['openFile'],
        })
      : await dialog.showOpenDialog({
          filters: [{ name: 'JSON', extensions: ['json'] }],
          properties: ['openFile'],
        })

    if (result.canceled || result.filePaths.length === 0) return null

    const content = fs.readFileSync(result.filePaths[0], 'utf-8')
    const data = JSON.parse(content) as {
      name: string
      ksp_version: string
      mods: Array<{ identifier: string; version: string }>
    }

    return {
      name: data.name,
      ksp_version: data.ksp_version,
      mods: data.mods,
    }
  })

  ipcMain.handle('profiles:validatePath', (_event, kspPath: string) => {
    const valid = profile.validateKspPath(kspPath)
    if (valid) {
      const kspVersion = profile.detectKspVersion(kspPath)
      return { valid: true, message: 'Valid KSP installation', kspVersion }
    }
    return { valid: false, message: 'No GameData folder found — is this a KSP install?' }
  })

  ipcMain.handle('profiles:scanInstalled', (_event, profileId: string) => {
    try {
      return profile.scanInstalledMods(profileId)
    } catch (err: unknown) {
      const msg = err instanceof Error ? `${err.message}\n${err.stack}` : JSON.stringify(err)
      console.error('[scanInstalled] CRASH:', msg)
      return { found: 0, mods: [], fromCkan: 0, error: msg }
    }
  })

  ipcMain.handle('profiles:autoDetect', () => {
    return profile.autoDetectKspPaths()
  })

  ipcMain.handle('profiles:getInstalled', (_event, profileId: string) => {
    return db.getInstalledMods(profileId)
  })

  ipcMain.handle('profiles:switch', (_event, fromProfileId: string, toProfileId: string) => {
    log.info(`Switching profile: ${fromProfileId} -> ${toProfileId}`)
    const fromProfile = db.getProfile(fromProfileId)
    if (!fromProfile) throw new Error(`Profile ${fromProfileId} not found`)
    const result = profile.switchProfile(fromProfileId, toProfileId, fromProfile.ksp_path, modCache)
    log.info(`Profile switch complete: ${fromProfileId} -> ${toProfileId}`)
    return result
  })

  // --- Mod Cache ---
  ipcMain.handle('modcache:getSize', () => {
    return modCache.getCacheSize()
  })

  ipcMain.handle('modcache:clear', () => {
    modCache.clearCache()
    return { success: true }
  })

  // --- Meta ---
  ipcMain.handle('meta:sync', async () => {
    log.info('Meta sync started')
    const win = BrowserWindow.getFocusedWindow()
    const count = await metaSync.sync((current, total, phase) => {
      win?.webContents.send('meta:sync-progress', { current, total, phase })
    })
    log.info(`Meta sync complete: ${count} mods indexed`)
    db.setSetting('last_sync_time', Date.now().toString())
    return { count }
  })

  ipcMain.handle('meta:resetAll', () => {
    // Delete all data from DB
    db.close()
    const fs = require('fs')
    const path = require('path')
    const userData = require('electron').app.getPath('userData')
    const dbFile = path.join(userData, 'ksp-forge.db')
    const metaDir = path.join(userData, 'ckan-meta')
    try { fs.unlinkSync(dbFile) } catch {}
    try { fs.unlinkSync(dbFile + '-shm') } catch {}
    try { fs.unlinkSync(dbFile + '-wal') } catch {}
    try { fs.rmSync(metaDir, { recursive: true, force: true }) } catch {}
    // Reopen fresh DB
    db.reopen()
    db.init()
    return { success: true }
  })

  ipcMain.handle('meta:getLastSync', () => {
    const ts = db.getSetting('last_sync_time')
    return ts ? parseInt(ts, 10) : null
  })

  // --- Repositories ---
  ipcMain.handle('repos:getAll', () => {
    return db.getRepositories()
  })

  ipcMain.handle('repos:add', (_event, repo: { id: string; name: string; url: string; enabled: number; priority: number }) => {
    db.upsertRepository(repo)
    return { success: true }
  })

  ipcMain.handle('repos:update', (_event, repo: { id: string; name: string; url: string; enabled: number; priority: number }) => {
    db.upsertRepository(repo)
    return { success: true }
  })

  ipcMain.handle('repos:remove', (_event, id: string) => {
    db.deleteRepository(id)
    return { success: true }
  })

  // --- Audit ---
  ipcMain.handle('profiles:audit', (_event, profileId: string) => {
    const installed = db.getInstalledMods(profileId)
    const profileRow = db.getProfile(profileId)
    const kspVersion = profileRow?.ksp_version ?? ''
    const installedSet = new Set(installed.map(m => m.identifier))

    const updates: Array<{ identifier: string; installedVersion: string; availableVersion: string }> = []
    const missingDeps: Array<{ identifier: string; missingDep: string }> = []
    const incompatible: Array<{ identifier: string; version: string }> = []
    const orphans: Array<{ identifier: string; version: string }> = []

    for (const mod of installed) {
      const modRow = db.getMod(mod.identifier)
      // Update check (skip if installed version is unknown)
      if (modRow && modRow.latest_version && mod.version !== 'unknown' && modRow.latest_version !== mod.version) {
        updates.push({ identifier: mod.identifier, installedVersion: mod.version, availableVersion: modRow.latest_version })
      }
      // Dependency check
      const versions = db.getModVersions(mod.identifier)
      const vRow = versions.find(v => v.version === mod.version) ?? versions[0]
      if (vRow?.depends) {
        const deps: Array<{ name: string }> = JSON.parse(vRow.depends)
        for (const dep of deps) {
          if (!installedSet.has(dep.name)) {
            missingDeps.push({ identifier: mod.identifier, missingDep: dep.name })
          }
        }
      }
      // Orphan check (dependency that nothing directly installed depends on)
      if (mod.is_dependency === 1) {
        const neededBy = installed.filter(m => {
          if (m.identifier === mod.identifier) return false
          const vs = db.getModVersions(m.identifier)
          const vr = vs.find(v => v.version === m.version) ?? vs[0]
          if (!vr?.depends) return false
          const deps: Array<{ name: string }> = JSON.parse(vr.depends)
          return deps.some(d => d.name === mod.identifier)
        })
        if (neededBy.length === 0) orphans.push({ identifier: mod.identifier, version: mod.version })
      }
      // Compat check
      if (kspVersion && vRow) {
        const compat = vRow.ksp_version === 'any' || !vRow.ksp_version && !vRow.ksp_version_min && !vRow.ksp_version_max
        if (!compat && vRow.ksp_version && !vRow.ksp_version.startsWith(kspVersion.slice(0,3))) {
          incompatible.push({ identifier: mod.identifier, version: mod.version })
        }
      }
    }

    return { updates, missingDeps, incompatible, orphans }
  })

  ipcMain.handle('profiles:getOrphans', (_event, profileId: string) => {
    const installed = db.getInstalledMods(profileId)
    const installedSet = new Set(installed.map(m => m.identifier))
    // Build set of all declared dependency names
    const neededDeps = new Set<string>()
    for (const mod of installed) {
      const versions = db.getModVersions(mod.identifier)
      const vRow = versions.find(v => v.version === mod.version) ?? versions[0]
      if (vRow?.depends) {
        const deps: Array<{ name: string }> = JSON.parse(vRow.depends)
        deps.forEach(d => neededDeps.add(d.name))
      }
    }
    return installed.filter(m => m.is_dependency === 1 && installedSet.has(m.identifier) && !neededDeps.has(m.identifier))
  })

  // --- Update check ---
  ipcMain.handle('app:checkUpdate', async () => {
    try {
      const { app } = require('electron')
      const currentVersion = app.getVersion()
      const res = await fetch('https://api.github.com/repos/JLSkyzer/ckanrework/releases/latest', {
        headers: { 'User-Agent': 'KSP-Forge' }
      })
      if (!res.ok) return null
      const data = await res.json()
      const latestTag = (data.tag_name || '').replace(/^v/, '')
      if (!latestTag) return null
      // Compare with semver: only notify if latest is GREATER than current
      const semver = require('semver')
      if (semver.valid(latestTag) && semver.valid(currentVersion) && semver.gt(latestTag, currentVersion)) {
        return { currentVersion, latestVersion: latestTag, url: data.html_url }
      }
      return null
    } catch { return null }
  })

  ipcMain.handle('app:openUrl', (_event, url: string) => {
    shell.openExternal(url)
  })

  ipcMain.handle('app:getVersion', () => {
    const { app } = require('electron')
    return app.getVersion()
  })

  // --- Dialog ---
  ipcMain.handle('dialog:selectFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // --- Logs ---
  ipcMain.handle('logs:export', async () => {
    const content = log.exportLogs()
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showSaveDialog(win, {
          defaultPath: `ksp-forge-logs.txt`,
          filters: [{ name: 'Text', extensions: ['txt'] }],
        })
      : await dialog.showSaveDialog({
          defaultPath: `ksp-forge-logs.txt`,
          filters: [{ name: 'Text', extensions: ['txt'] }],
        })
    if (result.canceled || !result.filePath) return { success: false }
    fs.writeFileSync(result.filePath, content, 'utf-8')
    log.info(`Logs exported to ${result.filePath}`)
    return { success: true, path: result.filePath }
  })

  ipcMain.handle('logs:openFolder', () => {
    shell.openPath(log.getLogsDir())
    return { success: true }
  })
}
