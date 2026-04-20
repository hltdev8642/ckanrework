import { BrowserWindow } from 'electron'
import type { CurseForgeFileInfo, CurseForgeInstallCandidate, CurseForgeProjectDetail, ModRow } from '../types'
import type { DatabaseService } from './database'

const BASE_URL = 'https://www.curseforge.com'
const API_BASE_URL = 'https://api.curseforge.com'
const SEARCH_URL = `${BASE_URL}/kerbal/search?class=ksp-mods&page=1&pageSize=20&sortBy=relevancy`

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function absoluteUrl(url: string | null | undefined): string | null {
  if (!url) return null
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  if (url.startsWith('/')) return `${BASE_URL}${url}`
  return `${BASE_URL}/${url}`
}

function parseTextDate(value: string | null | undefined): string | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function parseSizeToBytes(value: string | null | undefined): number | null {
  if (!value) return null
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i)
  if (!match) return null
  const amount = parseFloat(match[1])
  const unit = match[2].toUpperCase()
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
  }
  return Math.round(amount * (multipliers[unit] ?? 1))
}

function parseIdentifierSlug(identifier: string): string {
  return identifier.startsWith('curseforge:') ? identifier.slice('curseforge:'.length) : identifier
}

function buildIdentifier(slug: string): string {
  return `curseforge:${slug}`
}

function buildDirectDownloadUrl(fileId: number, fileName: string): string {
  const id = String(fileId)
  const first = id.slice(0, -3)
  const last = id.slice(-3)
  return `https://mediafilez.forgecdn.net/files/${first}/${last}/${encodeURIComponent(fileName)}`
}

export class CurseForgeService {
  private gameIdCache: number | null | undefined = undefined

  constructor(private db: DatabaseService) {}

  private getCurseForgeApiKey(): string | null {
    return this.db.getSetting('curseforgeApiKey')?.trim() || null
  }

  private async getCurseForgeGameId(): Promise<number | null> {
    if (this.gameIdCache !== undefined) return this.gameIdCache

    try {
      const response = await this.callApi<{ data: Array<any> }>('/v1/games')
      const game = response.data?.find((item) => {
        const name = String(item.name ?? '').toLowerCase()
        const slug = String(item.slug ?? '').toLowerCase()
        return slug.includes('kerbal') || name.includes('kerbal space program')
      })
      this.gameIdCache = game?.id ?? null
    } catch {
      this.gameIdCache = null
    }

    return this.gameIdCache
  }

  private async callApi<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
    const apiKey = this.getCurseForgeApiKey()
    if (!apiKey) {
      throw new Error('CurseForge API key is not configured')
    }

    const url = new URL(`${API_BASE_URL}${path}`)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value))
        }
      }
    }

    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'x-api-key': apiKey,
      },
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`CurseForge API request failed ${response.status} ${response.statusText}: ${text}`)
    }

    return response.json() as Promise<T>
  }

  private async searchModsViaApi(query: string): Promise<ModRow[]> {
    const gameId = await this.getCurseForgeGameId()
    if (!gameId) {
      throw new Error('CurseForge game ID could not be resolved')
    }

    const params: Record<string, string | number | boolean> = {
      gameId,
      pageSize: 50,
    }
    if (query.trim()) {
      params.searchFilter = query.trim()
    }

    const response = await this.callApi<{ data: Array<any> }>('/v1/mods/search', params)
    if (!response.data) {
      return []
    }

    return response.data.map((mod) => this.mapApiModToModRow(mod))
  }

  private mapApiModToModRow(mod: any): ModRow {
    const author = Array.isArray(mod.authors) && mod.authors.length > 0 ? mod.authors[0].name : 'Unknown'
    const projectUrl = mod.links?.websiteUrl || `${BASE_URL}/kerbal/ksp-mods/${mod.slug}`
    const file = Array.isArray(mod.latestFiles) ? mod.latestFiles[0] : null

    return {
      identifier: buildIdentifier(mod.slug),
      name: mod.name,
      abstract: mod.summary || null,
      author,
      license: 'Unknown',
      latest_version: file?.fileName || 'Latest',
      ksp_version: file?.gameVersions?.[0] || null,
      ksp_version_min: null,
      ksp_version_max: null,
      download_url: file?.downloadUrl || null,
      download_size: file?.fileSizeOnDisk ?? file?.fileLength ?? null,
      spacedock_id: null,
      tags: Array.isArray(mod.categories) && mod.categories.length > 0 ? JSON.stringify(mod.categories.map((category: any) => category.name)) : null,
      resources: JSON.stringify({
        source: 'curseforge',
        homepage: projectUrl,
        curseforgeProjectUrl: projectUrl,
        curseforgeImageUrl: mod.logo?.url ?? null,
        curseforgeFileId: file?.id ?? null,
      }),
      release_date: mod.dateReleased ?? null,
      updated_at: Date.now(),
    }
  }

  private async getProjectDetailViaApi(identifier: string): Promise<CurseForgeProjectDetail> {
    const gameId = await this.getCurseForgeGameId()
    if (!gameId) {
      throw new Error('CurseForge game ID could not be resolved')
    }

    const slug = parseIdentifierSlug(identifier)
    const response = await this.callApi<{ data: Array<any> }>('/v1/mods/search', {
      gameId,
      slug,
      pageSize: 1,
    })

    const mod = response.data?.[0]
    if (!mod) {
      throw new Error('CurseForge project not found via API')
    }

    const descriptionHtml = await this.fetchModDescription(mod.id).catch(() => mod.summary || '')
    const screenshots = Array.isArray(mod.screenshots) ? mod.screenshots.map((s: any) => s.url).filter(Boolean) : []
    const latestFile = Array.isArray(mod.latestFiles) && mod.latestFiles.length > 0 ? mod.latestFiles[0] : null

    return {
      identifier: buildIdentifier(slug),
      slug,
      projectUrl: mod.links?.websiteUrl || `${BASE_URL}/kerbal/ksp-mods/${slug}`,
      author: Array.isArray(mod.authors) && mod.authors.length > 0 ? mod.authors[0].name : 'Unknown',
      imageUrl: mod.logo?.url || null,
      descriptionHtml,
      screenshots: Array.from(new Set(screenshots as string[])),
      links: {
        homepage: mod.links?.websiteUrl ?? undefined,
        repository: mod.links?.sourceUrl ?? undefined,
        bugtracker: mod.links?.issuesUrl ?? undefined,
        issues: undefined,
        files: undefined,
      },
      latestFile: latestFile
        ? {
            fileId: latestFile.id,
            fileName: latestFile.fileName,
            version: latestFile.displayName || latestFile.fileName,
            uploadedAt: parseTextDate(latestFile.fileDate),
            fileSize: latestFile.fileSizeOnDisk ?? latestFile.fileLength ?? null,
            fileSizeText: null,
            supportedVersions: latestFile.gameVersions ?? [],
            changelogHtml: null,
            downloadUrl: latestFile.downloadUrl,
          }
        : null,
    }
  }

  private async fetchModDescription(modId: number): Promise<string> {
    const response = await this.callApi<{ data: string }>(`/v1/mods/${modId}/description`, { markup: true })
    return typeof response.data === 'string' ? response.data : ''
  }

  async searchMods(query: string): Promise<ModRow[]> {
    const apiResults = await this.searchModsViaApi(query).catch(() => null)
    if (apiResults !== null) {
      return apiResults
    }

    const url = query.trim()
      ? `${SEARCH_URL}&search=${encodeURIComponent(query.trim())}`
      : SEARCH_URL

    const results = await this.withPage<Array<{
      slug: string
      projectUrl: string
      name: string
      author: string
      summary: string
      imageUrl: string | null
      downloads: string
      latestRelease: string
      createdAt: string
      fileSizeText: string
      gameVersion: string
      fileId: number | null
      tags: string[]
    }>>(url, this.searchExtractor())

    return results.map((result) => this.mapSearchResultToMod(result))
  }

  async getProjectDetail(identifier: string): Promise<CurseForgeProjectDetail> {
    const apiDetail = await this.getProjectDetailViaApi(identifier).catch(() => null)
    if (apiDetail) return apiDetail

    const slug = parseIdentifierSlug(identifier)
    const projectUrl = `${BASE_URL}/kerbal/ksp-mods/${slug}`
    const project = await this.withPage<{
      title: string
      author: string
      imageUrl: string | null
      descriptionHtml: string
      filesHref: string | null
      firstFileHref: string | null
      screenshots: string[]
      externalLinks: string[]
    }>(projectUrl, this.projectDetailExtractor())

    let latestFile: CurseForgeFileInfo | null = null
    const fileHref = absoluteUrl(project.firstFileHref)
    if (fileHref) {
      const file = await this.withPage<{
        heading: string
        fileName: string
        supportedVersions: string[]
        uploadedAt: string
        fileSizeText: string
        changelogHtml: string | null
      }>(fileHref, this.fileDetailExtractor())
      const fileId = Number(fileHref.match(/\/(\d+)$/)?.[1] ?? 0)
      const fileName = file.fileName || file.heading || `${slug}.zip`
      latestFile = {
        fileId,
        fileName,
        version: fileName.replace(/\.zip$/i, ''),
        uploadedAt: parseTextDate(file.uploadedAt),
        fileSize: parseSizeToBytes(file.fileSizeText),
        fileSizeText: file.fileSizeText || null,
        supportedVersions: file.supportedVersions,
        changelogHtml: file.changelogHtml,
        downloadUrl: buildDirectDownloadUrl(fileId, fileName),
      }
    }

    return {
      identifier: buildIdentifier(slug),
      slug,
      projectUrl,
      author: project.author || 'Unknown',
      imageUrl: project.imageUrl,
      descriptionHtml: project.descriptionHtml,
      screenshots: Array.from(new Set(project.screenshots.map((src) => absoluteUrl(src)).filter(Boolean) as string[])),
      links: {
        ...this.extractProjectLinks(project.externalLinks),
        files: absoluteUrl(project.filesHref) ?? undefined,
      },
      latestFile,
    }
  }

  private async withPage<T>(url: string, extractor: string): Promise<T> {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

    try {
      await win.loadURL(url, { userAgent })
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          win.webContents.once('did-finish-load', () => resolve())
          win.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
            reject(new Error(`Page load failed (${errorCode}): ${errorDescription} - ${validatedURL}`))
          })
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 10000)),
      ])
      await delay(2000)
      return await win.webContents.executeJavaScript(extractor, true) as T
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }

  private searchExtractor(): string {
    return `(() => {
      const cards = Array.from(document.querySelectorAll('div.project-card'))
      return cards.map((card) => {
        const nameLink = card.querySelector('a.name[href^="/kerbal/ksp-mods/"]') || card.querySelector('a.overlay-link[href^="/kerbal/ksp-mods/"]')
        const href = nameLink?.getAttribute('href') || ''
        const slug = href.split('/').filter(Boolean).pop() || ''
        const downloadHref = card.querySelector('a.download-cta[href*="/download/"]')?.getAttribute('href') || null
        const fileIdMatch = downloadHref?.match(/\/(\d+)$/)
        const tags = Array.from(card.querySelectorAll('ul.categories li a'))
          .map((node) => (node.textContent || '').trim())
          .filter((value) => value && value !== 'Mods')
        return {
          slug,
          projectUrl: href,
          name: (card.querySelector('a.name .ellipsis')?.textContent || '').trim(),
          author: (card.querySelector('.author-name .ellipsis')?.textContent || '').trim(),
          summary: (card.querySelector('p.description')?.textContent || '').trim(),
          imageUrl: card.querySelector('.art img')?.getAttribute('src') || null,
          downloads: (card.querySelector('li.detail-downloads')?.textContent || '').trim(),
          latestRelease: (card.querySelector('li.detail-updated span')?.textContent || '').trim(),
          createdAt: (card.querySelector('li.detail-created span')?.textContent || '').trim(),
          fileSizeText: (card.querySelector('li.detail-size')?.textContent || '').trim(),
          gameVersion: (card.querySelector('li.detail-game-version')?.textContent || '').trim(),
          fileId: fileIdMatch ? Number(fileIdMatch[1]) : null,
          tags,
        }
      }).filter((entry) => entry.slug && entry.name)
    })()`
  }

  private projectDetailExtractor(): string {
    return `(() => {
      const textOf = (selector) => (document.querySelector(selector)?.textContent || '').trim()
      const links = Array.from(document.querySelectorAll('.project-description a[href]'))
        .map((node) => node.getAttribute('href'))
        .filter(Boolean)
      const screenshots = Array.from(document.querySelectorAll('.screenshots-slider img, .project-description img'))
        .map((img) => img.getAttribute('src'))
        .filter((src) => !!src && !src.includes('/avatars/'))
      const fileLinks = Array.from(document.querySelectorAll('a[href]'))
        .map((node) => node.getAttribute('href'))
        .filter((href) => href && /\/kerbal\/ksp-mods\/[^/]+\/files\/\d+$/.test(href))
      return {
        title: textOf('h1'),
        author: textOf('a[href^="/members/"]'),
        imageUrl: document.querySelector('img[src*="banners-image-urls"]')?.getAttribute('src') || document.querySelector('.project-card img[src*="media.forgecdn.net"]')?.getAttribute('src') || null,
        descriptionHtml: document.querySelector('.project-description')?.innerHTML || '',
        filesHref: Array.from(document.querySelectorAll('a[href]')).find((node) => ((node.textContent || '').trim().startsWith('Files')))?.getAttribute('href') || null,
        firstFileHref: fileLinks[0] || null,
        screenshots,
        externalLinks: links,
      }
    })()`
  }

  private fileDetailExtractor(): string {
    return `(() => {
      const getNextListValues = (headingText) => {
        const heading = Array.from(document.querySelectorAll('h3')).find((node) => (node.textContent || '').trim() === headingText)
        if (!heading) return []
        const list = heading.nextElementSibling
        if (!list) return []
        return Array.from(list.querySelectorAll('li')).map((node) => (node.textContent || '').trim()).filter(Boolean)
      }
      const fileNameHeading = Array.from(document.querySelectorAll('h3')).find((node) => (node.textContent || '').trim() === 'File Name')
      const fileName = fileNameHeading?.nextElementSibling?.textContent?.trim() || ''
      const headingH2 = Array.from(document.querySelectorAll('h2')).map((node) => (node.textContent || '').trim()).find((text) => text && text !== 'File Details') || ''
      const infoItems = Array.from(document.querySelectorAll('main li')).map((node) => (node.textContent || '').trim()).filter(Boolean)
      const uploadedItem = infoItems.find((item) => item.startsWith('Uploaded ')) || ''
      const fileSizeItem = infoItems.find((item) => item.startsWith('File size ')) || ''
      const changelogLink = Array.from(document.querySelectorAll('a[href]')).find((node) => (node.textContent || '').trim() === 'Changelog')?.getAttribute('href') || null
      const knownIssues = Array.from(document.querySelectorAll('h2')).find((node) => (node.textContent || '').trim() === 'Known Issues')
      const changelogHtml = knownIssues?.previousElementSibling?.innerHTML || null
      return {
        heading: headingH2,
        fileName,
        supportedVersions: getNextListValues('Supported Versions'),
        uploadedAt: uploadedItem.replace(/^Uploaded\s+/, ''),
        fileSizeText: fileSizeItem.replace(/^File size\s+/, ''),
        changelogHtml,
        changelogLink,
      }
    })()`
  }

  private extractProjectLinks(urls: string[]): CurseForgeProjectDetail['links'] {
    const links: CurseForgeProjectDetail['links'] = {}
    for (const raw of urls) {
      const href = absoluteUrl(raw)
      if (!href) continue
      if (!links.repository && /github\.com|gitlab\.com/i.test(href)) {
        links.repository = href
        continue
      }
      if (!links.bugtracker && /issues|jira|bug/i.test(href)) {
        links.bugtracker = href
        continue
      }
      if (!links.homepage && !href.includes('curseforge.com')) {
        links.homepage = href
      }
    }
    return links
  }

  private mapSearchResultToMod(result: {
    slug: string
    projectUrl: string
    name: string
    author: string
    summary: string
    imageUrl: string | null
    downloads: string
    latestRelease: string
    createdAt: string
    fileSizeText: string
    gameVersion: string
    fileId: number | null
    tags: string[]
  }): ModRow {
    return {
      identifier: buildIdentifier(result.slug),
      name: result.name,
      abstract: result.summary || null,
      author: result.author || 'Unknown',
      license: 'Unknown',
      latest_version: 'Latest',
      ksp_version: result.gameVersion || null,
      ksp_version_min: null,
      ksp_version_max: null,
      download_url: result.fileId ? `${BASE_URL}/kerbal/ksp-mods/${result.slug}/download/${result.fileId}` : absoluteUrl(result.projectUrl),
      download_size: parseSizeToBytes(result.fileSizeText),
      spacedock_id: null,
      tags: result.tags.length > 0 ? JSON.stringify(result.tags) : null,
      resources: JSON.stringify({
        source: 'curseforge',
        homepage: absoluteUrl(result.projectUrl),
        curseforgeProjectUrl: absoluteUrl(result.projectUrl),
        curseforgeImageUrl: result.imageUrl,
        curseforgeDownloadsText: result.downloads,
        curseforgeFileId: result.fileId,
        curseforgeFileSizeText: result.fileSizeText,
      }),
      release_date: parseTextDate(result.latestRelease),
      updated_at: Date.now(),
    }
  }

  async searchMods(query: string): Promise<ModRow[]> {
    const apiResults = await this.searchModsViaApi(query).catch(() => null)
    if (apiResults !== null) {
      return apiResults
    }

    const url = query.trim()
      ? `${SEARCH_URL}&search=${encodeURIComponent(query.trim())}`
      : SEARCH_URL

    const results = await this.withPage<Array<{
      slug: string
      projectUrl: string
      name: string
      author: string
      summary: string
      imageUrl: string | null
      downloads: string
      latestRelease: string
      createdAt: string
      fileSizeText: string
      gameVersion: string
      fileId: number | null
      tags: string[]
    }>>(url, this.searchExtractor())

    return results.map((result) => this.mapSearchResultToMod(result))
  }

  async getProjectDetail(identifier: string): Promise<CurseForgeProjectDetail> {
    const apiDetail = await this.getProjectDetailViaApi(identifier).catch(() => null)
    if (apiDetail) return apiDetail

    const slug = parseIdentifierSlug(identifier)
    const projectUrl = `${BASE_URL}/kerbal/ksp-mods/${slug}`
    const project = await this.withPage<{
      title: string
      author: string
      imageUrl: string | null
      descriptionHtml: string
      filesHref: string | null
      firstFileHref: string | null
      screenshots: string[]
      externalLinks: string[]
    }>(projectUrl, this.projectDetailExtractor())

    let latestFile: CurseForgeFileInfo | null = null
    const fileHref = absoluteUrl(project.firstFileHref)
    if (fileHref) {
      const file = await this.withPage<{
        heading: string
        fileName: string
        supportedVersions: string[]
        uploadedAt: string
        fileSizeText: string
        changelogHtml: string | null
      }>(fileHref, this.fileDetailExtractor())
      const fileId = Number(fileHref.match(/\/(\d+)$/)?.[1] ?? 0)
      const fileName = file.fileName || file.heading || `${slug}.zip`
      latestFile = {
        fileId,
        fileName,
        version: fileName.replace(/\.zip$/i, ''),
        uploadedAt: parseTextDate(file.uploadedAt),
        fileSize: parseSizeToBytes(file.fileSizeText),
        fileSizeText: file.fileSizeText || null,
        supportedVersions: file.supportedVersions,
        changelogHtml: file.changelogHtml,
        downloadUrl: buildDirectDownloadUrl(fileId, fileName),
      }
    }

    return {
      identifier: buildIdentifier(slug),
      slug,
      projectUrl,
      author: project.author || 'Unknown',
      imageUrl: project.imageUrl,
      descriptionHtml: project.descriptionHtml,
      screenshots: Array.from(new Set(project.screenshots.map((src) => absoluteUrl(src)).filter(Boolean) as string[])),
      links: {
        ...this.extractProjectLinks(project.externalLinks),
        files: absoluteUrl(project.filesHref) ?? undefined,
      },
      latestFile,
    }
  }

  async prepareInstall(mod: ModRow): Promise<CurseForgeInstallCandidate> {
    const resources = mod.resources ? JSON.parse(mod.resources) as Record<string, any> : {}
    const detail = await this.getProjectDetail(mod.identifier)
    const latestFile = detail.latestFile
    if (!latestFile) {
      throw new Error('No downloadable file found for this CurseForge project')
    }

    return {
      identifier: mod.identifier,
      name: mod.name,
      abstract: mod.abstract,
      author: mod.author,
      license: mod.license || 'Unknown',
      version: latestFile.version,
      kspVersion: latestFile.supportedVersions[0] ?? mod.ksp_version,
      downloadUrl: latestFile.downloadUrl,
      downloadSize: latestFile.fileSize,
      tags: mod.tags ? JSON.parse(mod.tags) as string[] : [],
      releaseDate: latestFile.uploadedAt ?? mod.release_date,
      projectUrl: detail.projectUrl,
      imageUrl: detail.imageUrl ?? resources.curseforgeImageUrl ?? null,
      descriptionHtml: detail.descriptionHtml,
      links: detail.links,
    }
  }
}
