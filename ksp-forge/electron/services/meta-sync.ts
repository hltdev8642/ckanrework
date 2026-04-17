import simpleGit from 'simple-git'
import { Worker } from 'worker_threads'
import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
import zlib from 'zlib'
import * as tar from 'tar'
import { URL as NodeURL } from 'url'
import { pipeline } from 'stream/promises'
import type { CkanMetadata, ModRow, ModVersionRow, RepositoryRow } from '../types'
import { DatabaseService } from './database'

const OFFICIAL_CKAN_META_URL = 'https://github.com/KSP-CKAN/CKAN-meta.git'

/**
 * Normalise user-supplied repo URLs to a usable form:
 *  - GitHub tree/browse URLs → GitHub archive tarball
 *  - Bare GitHub repo URLs   → .git clone URL
 *  - .tar.gz / .git / other  → unchanged
 */
function normaliseRepoUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '') // strip trailing slashes

  // Already a tarball URL
  if (trimmed.endsWith('.tar.gz') || trimmed.endsWith('.tgz')) return trimmed

  // GitHub tree/blob URL → archive tarball, e.g.:
  //   https://github.com/org/repo/tree/main[/subdir] → https://github.com/org/repo/archive/main.tar.gz
  const ghTree = trimmed.match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+)\/(?:tree|blob)\/([^/]+)/)
  if (ghTree) return `${ghTree[1]}/archive/${ghTree[2]}.tar.gz`

  // Bare GitHub repo URL (no .git) → add .git so simple-git can clone it
  const ghBase = trimmed.match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+)$/)
  if (ghBase && !trimmed.endsWith('.git')) return `${ghBase[1]}.git`

  return trimmed
}

/**
 * Return the directory that actually contains the per-mod subdirectories.
 * Some repos (e.g. RSS-Reborn) place .ckan files under a `ckan/` subdirectory
 * rather than directly in the repo root.
 */
function detectScanPath(repoPath: string): string {
  const ckanSub = path.join(repoPath, 'ckan')
  if (fs.existsSync(ckanSub)) {
    try {
      const entries = fs.readdirSync(ckanSub, { withFileTypes: true })
      if (entries.some(e => e.isDirectory())) return ckanSub
    } catch { /* fall through */ }
  }
  return repoPath
}

/** Download a .tar.gz URL and extract it to `dest`, following redirects. */
function downloadTarball(url: string, dest: string, redirects = 0): Promise<void> {
  if (redirects > 10) return Promise.reject(new Error('Too many redirects'))
  return new Promise((resolve, reject) => {
    const parsed = new NodeURL(url)
    const get = parsed.protocol === 'https:' ? https.get : http.get
    get(url, { headers: { 'User-Agent': 'KSP-Forge/1.0' } }, (res) => {
      const code = res.statusCode ?? 0
      if (code === 301 || code === 302 || code === 307 || code === 308) {
        res.resume()
        downloadTarball(res.headers.location!, dest, redirects + 1).then(resolve, reject)
        return
      }
      if (code < 200 || code >= 300) {
        res.resume()
        reject(new Error(`HTTP ${code} fetching ${url}`))
        return
      }
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true })
      pipeline(res, zlib.createGunzip(), tar.x({ cwd: dest, strip: 1 }) as any)
        .then(() => resolve(), reject)
    }).on('error', reject)
  })
}

export function extractSpaceDockId(url: string | undefined): number | null {
  if (!url) return null
  const match = url.match(/spacedock\.info\/mod\/(\d+)/)
  return match ? parseInt(match[1], 10) : null
}

export function parseCkanFile(ckan: CkanMetadata): { mod: ModRow; version: ModVersionRow } {
  const author = Array.isArray(ckan.author) ? ckan.author.join(', ') : ckan.author
  const license = Array.isArray(ckan.license) ? ckan.license.join(', ') : ckan.license
  const spacedockId = extractSpaceDockId(ckan.resources?.spacedock)

  const mod: ModRow = {
    identifier: ckan.identifier,
    name: ckan.name,
    abstract: ckan.abstract ?? null,
    author,
    license,
    latest_version: ckan.version,
    ksp_version: ckan.ksp_version ?? null,
    ksp_version_min: ckan.ksp_version_min ?? null,
    ksp_version_max: ckan.ksp_version_max ?? null,
    download_url: ckan.download ?? null,
    download_size: ckan.download_size ?? null,
    spacedock_id: spacedockId,
    tags: ckan.tags ? JSON.stringify(ckan.tags) : null,
    resources: ckan.resources ? JSON.stringify(ckan.resources) : null,
    release_date: ckan.release_date ?? null,
    updated_at: Date.now()
  }

  const version: ModVersionRow = {
    identifier: ckan.identifier,
    version: ckan.version,
    ksp_version: ckan.ksp_version ?? null,
    ksp_version_min: ckan.ksp_version_min ?? null,
    ksp_version_max: ckan.ksp_version_max ?? null,
    download_url: ckan.download,
    download_hash: ckan.download_hash?.sha256 ?? ckan.download_hash?.sha1 ?? null,
    download_size: ckan.download_size ?? null,
    depends: ckan.depends ? JSON.stringify(ckan.depends) : null,
    recommends: ckan.recommends ? JSON.stringify(ckan.recommends) : null,
    suggests: ckan.suggests ? JSON.stringify(ckan.suggests) : null,
    conflicts: ckan.conflicts ? JSON.stringify(ckan.conflicts) : null,
    provides: ckan.provides ? JSON.stringify(ckan.provides) : null,
    install_directives: JSON.stringify(ckan.install)
  }

  return { mod, version }
}

export class MetaSyncService {
  private repoPath: string
  private db: DatabaseService
  private dbPath: string

  constructor(repoPath: string, db: DatabaseService, dbPath?: string) {
    this.repoPath = repoPath
    this.db = db
    this.dbPath = dbPath || ''
  }

  setDbPath(dbPath: string) {
    this.dbPath = dbPath
  }

  private async cloneOrPull(rawUrl: string, localPath: string): Promise<void> {
    const url = normaliseRepoUrl(rawUrl)

    // Tarball-based repo (CKAN standard): always re-download (no incremental update)
    if (url.endsWith('.tar.gz') || url.endsWith('.tgz')) {
      if (fs.existsSync(localPath)) {
        fs.rmSync(localPath, { recursive: true, force: true })
      }
      await downloadTarball(url, localPath)
      return
    }

    // Git-based repo
    const git = simpleGit()
    const gitDir = path.join(localPath, '.git')
    const lockFile = path.join(gitDir, 'index.lock')

    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile)
    }

    if (!fs.existsSync(gitDir)) {
      if (fs.existsSync(localPath)) {
        fs.rmSync(localPath, { recursive: true, force: true })
      }
      await git.clone(url, localPath, ['--depth', '1'])
    } else {
      try {
        const localGit = simpleGit(localPath)
        await localGit.pull()
      } catch {
        fs.rmSync(localPath, { recursive: true, force: true })
        await git.clone(url, localPath, ['--depth', '1'])
      }
    }
  }

  /**
   * Scan CKAN directories for repository configurations
   */
  private scanCkanDirectories(): RepositoryRow[] {
    const ckanRepos: RepositoryRow[] = []
    const userDataDir = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
    const ckanDirs = [
      path.join(userDataDir, 'CKAN'),
      path.join(userDataDir, 'CKAN', 'repos')
    ]

    for (const ckanDir of ckanDirs) {
      if (!fs.existsSync(ckanDir)) continue

      try {
        const entries = fs.readdirSync(ckanDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue

          const filePath = path.join(ckanDir, entry.name)
          try {
            const content = fs.readFileSync(filePath, 'utf-8')
            const config = JSON.parse(content)

            // Check if this is a CKAN repository configuration
            if (config.repositories && Array.isArray(config.repositories)) {
              for (const repo of config.repositories) {
                if (repo.uri && repo.name) {
                  // Generate a unique ID based on the URI
                  const id = `ckan-${Buffer.from(repo.uri).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 20)}`
                  ckanRepos.push({
                    id,
                    name: repo.name,
                    url: repo.uri,
                    enabled: 1,
                    priority: 10 // Lower priority than manually added repos
                  })
                }
              }
            }
            // Also check for direct repository configuration (some CKAN versions)
            else if (config.uri && config.name) {
              const id = `ckan-${Buffer.from(config.uri).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 20)}`
              ckanRepos.push({
                id,
                name: config.name,
                url: config.uri,
                enabled: 1,
                priority: 10
              })
            }
          } catch (error) {
            console.warn(`[meta-sync] Failed to parse CKAN config file ${filePath}:`, error)
          }
        }
      } catch (error) {
        console.warn(`[meta-sync] Failed to scan CKAN directory ${ckanDir}:`, error)
      }
    }

    return ckanRepos
  }

  async sync(onProgress?: (current: number, total: number, phase: string) => void): Promise<number> {
    let repos = this.db.getRepositories().filter(r => r.enabled)
    if (repos.length === 0) {
      repos = [{ id: 'official', name: 'CKAN Official', url: OFFICIAL_CKAN_META_URL, enabled: 1, priority: 0 }]
    }

    // Scan CKAN directories for additional repositories
    const ckanRepos = this.scanCkanDirectories()

    // Merge repositories, preferring manually added ones (lower priority number)
    const allRepos = new Map<string, RepositoryRow>()

    // Add manually configured repos first
    for (const repo of repos) {
      allRepos.set(repo.id, repo)
    }

    // Add CKAN directory repos if not already present
    for (const repo of ckanRepos) {
      if (!allRepos.has(repo.id)) {
        allRepos.set(repo.id, repo)
      }
    }

    repos = Array.from(allRepos.values()).sort((a, b) => a.priority - b.priority)

    onProgress?.(0, repos.length, 'downloading')

    const repoPaths: string[] = []
    for (let i = 0; i < repos.length; i++) {
      const repo = repos[i]
      const localPath = repo.url === OFFICIAL_CKAN_META_URL
        ? this.repoPath
        : path.join(path.dirname(this.repoPath), `ckan-repo-${repo.id}`)

      await this.cloneOrPull(repo.url, localPath)
      const scanPath = detectScanPath(localPath)
      console.log(`[meta-sync] repo "${repo.name}" → scanPath: ${scanPath}`)
      repoPaths.push(scanPath)
      onProgress?.(i + 1, repos.length, 'downloading')
    }

    onProgress?.(0, 1, 'indexing')

    const count = await new Promise<number>((resolve, reject) => {
      const workerPath = path.join(__dirname, 'index-worker.js')
      const worker = new Worker(workerPath, {
        workerData: { dbPath: this.dbPath, repoPaths }
      })

      worker.on('message', (msg) => {
        if (msg.type === 'progress') {
          onProgress?.(msg.current, msg.total, 'indexing')
        } else if (msg.type === 'done') {
          resolve(msg.total)
        } else if (msg.type === 'error') {
          reject(new Error(msg.message))
        } else if (msg.type === 'log') {
          console.log(msg.message)
        }
      })

      worker.on('error', reject)
    })

    return count
  }
}
