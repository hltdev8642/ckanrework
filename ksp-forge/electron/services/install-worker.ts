import { parentPort, workerData } from 'worker_threads'
import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
import crypto from 'crypto'
import unzipper from 'unzip-stream'

interface InstallJob {
  identifier: string
  version: string
  downloadUrl: string
  hash: string | null
  directives: Array<{ find?: string; file?: string; install_to: string; filter?: string | string[] }>
  kspPath: string
  tempDir: string
}

const job = workerData as InstallJob

function normalizeEntryPath(entryPath: string): string {
  return entryPath.replace(/\\/g, '/').replace(/^\.\//, '')
}

function applyGenericInstall(entries: { entryPath: string; buffer: Buffer }[]): { relDest: string; buffer: Buffer }[] {
  const gameDataEntries = entries
    .map((entry) => {
      const parts = normalizeEntryPath(entry.entryPath).split('/').filter(Boolean)
      const gameDataIndex = parts.findIndex((part) => part.toLowerCase() === 'gamedata')
      if (gameDataIndex === -1) return null
      const relDest = parts.slice(gameDataIndex).join('/')
      return relDest ? { relDest, buffer: entry.buffer } : null
    })
    .filter((entry): entry is { relDest: string; buffer: Buffer } => !!entry)

  if (gameDataEntries.length > 0) return gameDataEntries

  const roots = Array.from(
    new Set(
      entries
        .map((entry) => normalizeEntryPath(entry.entryPath).split('/').filter(Boolean)[0])
        .filter(Boolean),
    ),
  )

  if (roots.length === 1) {
    return entries.map((entry) => ({
      relDest: `GameData/${normalizeEntryPath(entry.entryPath)}`,
      buffer: entry.buffer,
    }))
  }

  throw new Error('Archive does not contain a GameData directory and install layout could not be inferred safely')
}

function download(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http
    const file = fs.createWriteStream(destPath)

    const req = proto.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close()
        try { fs.unlinkSync(destPath) } catch {}
        download(res.headers.location, destPath).then(resolve).catch(reject)
        return
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }

      const total = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null
      let downloaded = 0

      res.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        parentPort?.postMessage({ type: 'download-progress', downloaded, total })
      })

      res.pipe(file)
      file.on('finish', () => {
        file.close()
        resolve()
      })
      file.on('error', reject)
    })

    req.on('error', (err) => {
      file.close()
      try { fs.unlinkSync(destPath) } catch {}
      reject(err)
    })
  })
}

function sha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (data) => hash.update(data))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

function applyDirective(
  directive: InstallJob['directives'][0],
  entries: { entryPath: string; buffer: Buffer }[],
): { relDest: string; buffer: Buffer }[] {
  const results: { relDest: string; buffer: Buffer }[] = []
  const installTo = directive.install_to || 'GameData'

  let findPrefix = ''
  if (directive.find) {
    const match = entries.find((entry) => {
      const parts = normalizeEntryPath(entry.entryPath).split('/')
      return parts.some((part) => part === directive.find)
    })

    if (match) {
      const parts = normalizeEntryPath(match.entryPath).split('/')
      const index = parts.indexOf(directive.find)
      findPrefix = parts.slice(0, index).join('/')
      if (findPrefix) findPrefix += '/'
    }
  }

  for (const entry of entries) {
    let entryPath = normalizeEntryPath(entry.entryPath)

    if (directive.find) {
      if (!entryPath.startsWith(findPrefix + directive.find + '/') && entryPath !== findPrefix + directive.find) {
        continue
      }
      entryPath = entryPath.substring(findPrefix.length)
    } else if (directive.file) {
      if (entryPath !== directive.file && !entryPath.startsWith(directive.file + '/')) {
        continue
      }
    }

    if (directive.filter) {
      const filters = Array.isArray(directive.filter) ? directive.filter : [directive.filter]
      const name = path.basename(entryPath)
      if (filters.some((filterValue) => name === filterValue || entryPath.includes(filterValue))) {
        continue
      }
    }

    results.push({ relDest: path.join(installTo, entryPath), buffer: entry.buffer })
  }

  return results
}

function extractAndInstall(zipPath: string, kspPath: string, directives: InstallJob['directives']): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const installedFiles: string[] = []
    const entries: { entryPath: string; buffer: Buffer }[] = []
    const stream = fs.createReadStream(zipPath).pipe(unzipper.Parse({ forceStream: true }))

    stream.on('entry', (entry: any) => {
      if (entry.type === 'Directory') {
        entry.autodrain()
        return
      }

      const chunks: Buffer[] = []
      entry.on('data', (chunk: Buffer) => chunks.push(chunk))
      entry.on('end', () => {
        entries.push({ entryPath: entry.path, buffer: Buffer.concat(chunks) })
      })
      entry.on('error', reject)
    })

    stream.on('finish', () => {
      try {
        const targets = directives.length > 0
          ? directives.flatMap((directive) => applyDirective(directive, entries))
          : applyGenericInstall(entries)

        for (const { relDest, buffer } of targets) {
          const destPath = path.join(kspPath, relDest)
          fs.mkdirSync(path.dirname(destPath), { recursive: true })
          fs.writeFileSync(destPath, buffer)
          installedFiles.push(relDest)
        }

        if (installedFiles.length === 0) {
          throw new Error('Archive did not produce any installed files')
        }

        resolve(installedFiles)
      } catch (error) {
        reject(error)
      }
    })

    stream.on('error', reject)
  })
}

async function run() {
  try {
    fs.mkdirSync(job.tempDir, { recursive: true })
    const zipPath = path.join(job.tempDir, `${job.identifier}-${job.version}.zip`)

    parentPort?.postMessage({ type: 'status', status: 'downloading' })
    await download(job.downloadUrl, zipPath)

    if (job.hash) {
      parentPort?.postMessage({ type: 'status', status: 'verifying' })
      const actual = await sha256(zipPath)
      if (actual.toLowerCase() !== job.hash.toLowerCase()) {
        fs.unlinkSync(zipPath)
        throw new Error(`Hash mismatch: expected ${job.hash}, got ${actual}`)
      }
    }

    parentPort?.postMessage({ type: 'status', status: 'extracting' })
    const files = await extractAndInstall(zipPath, job.kspPath, job.directives)

    try { fs.unlinkSync(zipPath) } catch {}
    parentPort?.postMessage({ type: 'done', files })
  } catch (error: any) {
    parentPort?.postMessage({ type: 'error', message: error.message })
  }
}

run()
