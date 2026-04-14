import Database from 'better-sqlite3'
import type {
  ModRow,
  ModVersionRow,
  SpaceDockCacheRow,
  ProfileRow,
  InstalledModRow,
  RepositoryRow,
} from '../types'

/** Parse a version string into numeric parts, handling non-numeric segments and 'v' prefix. */
function parseVersionParts(v: string): number[] {
  const cleaned = v.replace(/^v/i, '')
  return cleaned.split('.').map(p => { const n = parseInt(p, 10); return isNaN(n) ? 0 : n })
}

function compareVersionStrings(a: string, b: string): number {
  const pa = parseVersionParts(a)
  const pb = parseVersionParts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va !== vb) return va - vb
  }
  return 0
}

export class DatabaseService {
  private db: Database.Database
  readonly dbPath: string

  constructor(dbPath: string) {
    this.dbPath = dbPath
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
  }

  reopen(): void {
    try { this.db.close() } catch { /* already closed */ }
    this.db = new Database(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mods (
        identifier      TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        abstract        TEXT,
        author          TEXT NOT NULL,
        license         TEXT NOT NULL,
        latest_version  TEXT NOT NULL,
        ksp_version     TEXT,
        ksp_version_min TEXT,
        ksp_version_max TEXT,
        download_url    TEXT,
        download_size   INTEGER,
        spacedock_id    INTEGER,
        tags            TEXT,
        resources       TEXT,
        release_date    TEXT,
        updated_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mod_versions (
        identifier          TEXT NOT NULL,
        version             TEXT NOT NULL,
        ksp_version         TEXT,
        ksp_version_min     TEXT,
        ksp_version_max     TEXT,
        download_url        TEXT,
        download_hash       TEXT,
        download_size       INTEGER,
        depends             TEXT,
        recommends          TEXT,
        suggests            TEXT,
        conflicts           TEXT,
        provides            TEXT,
        install_directives  TEXT NOT NULL,
        PRIMARY KEY (identifier, version)
      );

      CREATE TABLE IF NOT EXISTS spacedock_cache (
        spacedock_id      INTEGER PRIMARY KEY,
        mod_identifier    TEXT NOT NULL,
        description       TEXT,
        description_html  TEXT,
        background_url    TEXT,
        downloads         INTEGER,
        followers         INTEGER,
        fetched_at        INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        ksp_path    TEXT NOT NULL,
        ksp_version TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS installed_mods (
        profile_id       TEXT NOT NULL,
        identifier       TEXT NOT NULL,
        version          TEXT NOT NULL,
        installed_files  TEXT NOT NULL,
        installed_at     INTEGER NOT NULL,
        is_dependency    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (profile_id, identifier)
      );

      CREATE TABLE IF NOT EXISTS repositories (
        id       TEXT PRIMARY KEY,
        name     TEXT NOT NULL,
        url      TEXT NOT NULL,
        enabled  INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS mods_fts USING fts5(
        identifier,
        name,
        abstract,
        author,
        tags,
        content='mods',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS mods_fts_insert AFTER INSERT ON mods BEGIN
        INSERT INTO mods_fts(rowid, identifier, name, abstract, author, tags)
        VALUES (new.rowid, new.identifier, new.name, new.abstract, new.author, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS mods_fts_update AFTER UPDATE ON mods BEGIN
        INSERT INTO mods_fts(mods_fts, rowid, identifier, name, abstract, author, tags)
        VALUES ('delete', old.rowid, old.identifier, old.name, old.abstract, old.author, old.tags);
        INSERT INTO mods_fts(rowid, identifier, name, abstract, author, tags)
        VALUES (new.rowid, new.identifier, new.name, new.abstract, new.author, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS mods_fts_delete AFTER DELETE ON mods BEGIN
        INSERT INTO mods_fts(mods_fts, rowid, identifier, name, abstract, author, tags)
        VALUES ('delete', old.rowid, old.identifier, old.name, old.abstract, old.author, old.tags);
      END;
    `)

    // Seed default CKAN repository if table is empty
    const repoCount = (this.db.prepare(`SELECT COUNT(*) as n FROM repositories`).get() as { n: number }).n
    if (repoCount === 0) {
      this.db.prepare(
        `INSERT INTO repositories (id, name, url, enabled, priority) VALUES (?, ?, ?, 1, 0)`
      ).run('official', 'CKAN Official', 'https://github.com/KSP-CKAN/CKAN-meta.git')
    }

    // Migrations for existing databases
    try {
      const mvCols = this.db.prepare("PRAGMA table_info(mod_versions)").all() as Array<{ name: string; notnull: number }>

      // Make download_url nullable (was NOT NULL in older versions)
      const dlCol = mvCols.find(c => c.name === 'download_url')
      if (dlCol && dlCol.notnull === 1) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS mod_versions_new (
            identifier TEXT NOT NULL, version TEXT NOT NULL,
            ksp_version TEXT, ksp_version_min TEXT, ksp_version_max TEXT,
            download_url TEXT, download_hash TEXT, download_size INTEGER,
            depends TEXT, recommends TEXT, suggests TEXT, conflicts TEXT,
            provides TEXT,
            install_directives TEXT NOT NULL,
            PRIMARY KEY (identifier, version)
          );
          INSERT OR IGNORE INTO mod_versions_new SELECT *, NULL FROM mod_versions;
          DROP TABLE mod_versions;
          ALTER TABLE mod_versions_new RENAME TO mod_versions;
        `)
      } else if (!mvCols.find(c => c.name === 'provides')) {
        // Add provides column to existing mod_versions table
        this.db.exec(`ALTER TABLE mod_versions ADD COLUMN provides TEXT`)
      }

      // Add is_dependency to installed_mods if missing
      const imCols = this.db.prepare("PRAGMA table_info(installed_mods)").all() as Array<{ name: string }>
      if (!imCols.find(c => c.name === 'is_dependency')) {
        this.db.exec(`ALTER TABLE installed_mods ADD COLUMN is_dependency INTEGER NOT NULL DEFAULT 0`)
      }
    } catch { /* migration already applied or not needed */ }
  }

  listTables(): string[] {
    const rows = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[]
    return rows.map((r) => r.name)
  }

  upsertMod(mod: ModRow): void {
    this.db
      .prepare(
        `INSERT INTO mods (
          identifier, name, abstract, author, license, latest_version,
          ksp_version, ksp_version_min, ksp_version_max,
          download_url, download_size, spacedock_id, tags, resources, release_date, updated_at
        ) VALUES (
          @identifier, @name, @abstract, @author, @license, @latest_version,
          @ksp_version, @ksp_version_min, @ksp_version_max,
          @download_url, @download_size, @spacedock_id, @tags, @resources, @release_date, @updated_at
        )
        ON CONFLICT(identifier) DO UPDATE SET
          name            = excluded.name,
          abstract        = excluded.abstract,
          author          = excluded.author,
          license         = excluded.license,
          latest_version  = excluded.latest_version,
          ksp_version     = excluded.ksp_version,
          ksp_version_min = excluded.ksp_version_min,
          ksp_version_max = excluded.ksp_version_max,
          download_url    = excluded.download_url,
          download_size   = excluded.download_size,
          spacedock_id    = excluded.spacedock_id,
          tags            = excluded.tags,
          resources       = excluded.resources,
          release_date    = excluded.release_date,
          updated_at      = excluded.updated_at`
      )
      .run(mod)
  }

  getMod(identifier: string): ModRow | undefined {
    return this.db
      .prepare(`SELECT * FROM mods WHERE identifier = @identifier`)
      .get({ identifier }) as ModRow | undefined
  }

  getAllMods(): ModRow[] {
    return this.db
      .prepare(`SELECT * FROM mods ORDER BY name`)
      .all() as ModRow[]
  }

  searchMods(query: string): ModRow[] {
    // Strip invalid FTS5 column-filter tokens (e.g. installed:yes, compat:1.12)
    // Valid FTS columns are: identifier, name, abstract, author, tags
    const validFtsCols = new Set(['identifier', 'name', 'abstract', 'author', 'tags'])
    const stripped = query
      .split(/\s+/)
      .filter(token => {
        const m = token.match(/^([a-zA-Z_]+):/)
        return !m || validFtsCols.has(m[1].toLowerCase())
      })
      .join(' ')
    const sanitized = stripped.replace(/['"*]/g, ' ').trim()
    if (!sanitized) return this.getAllMods()
    return this.db
      .prepare(
        `SELECT mods.* FROM mods
         JOIN mods_fts ON mods.rowid = mods_fts.rowid
         WHERE mods_fts MATCH @query
         ORDER BY rank`
      )
      .all({ query: sanitized + '*' }) as ModRow[]
  }

  upsertModVersion(version: ModVersionRow): void {
    this.db
      .prepare(
        `INSERT INTO mod_versions (
          identifier, version, ksp_version, ksp_version_min, ksp_version_max,
          download_url, download_hash, download_size,
          depends, recommends, suggests, conflicts, provides, install_directives
        ) VALUES (
          @identifier, @version, @ksp_version, @ksp_version_min, @ksp_version_max,
          @download_url, @download_hash, @download_size,
          @depends, @recommends, @suggests, @conflicts, @provides, @install_directives
        )
        ON CONFLICT(identifier, version) DO UPDATE SET
          ksp_version         = excluded.ksp_version,
          ksp_version_min     = excluded.ksp_version_min,
          ksp_version_max     = excluded.ksp_version_max,
          download_url        = excluded.download_url,
          download_hash       = excluded.download_hash,
          download_size       = excluded.download_size,
          depends             = excluded.depends,
          recommends          = excluded.recommends,
          suggests            = excluded.suggests,
          conflicts           = excluded.conflicts,
          provides            = excluded.provides,
          install_directives  = excluded.install_directives`
      )
      .run(version)
  }

  getModVersions(identifier: string): ModVersionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM mod_versions WHERE identifier = @identifier`)
      .all({ identifier }) as ModVersionRow[]
    // Sort by semver descending (string sort puts 0.1.9 above 0.1.18)
    return rows.sort((a, b) => compareVersionStrings(b.version, a.version))
  }

  upsertSpaceDockCache(entry: SpaceDockCacheRow): void {
    this.db
      .prepare(
        `INSERT INTO spacedock_cache (
          spacedock_id, mod_identifier, description, description_html,
          background_url, downloads, followers, fetched_at
        ) VALUES (
          @spacedock_id, @mod_identifier, @description, @description_html,
          @background_url, @downloads, @followers, @fetched_at
        )
        ON CONFLICT(spacedock_id) DO UPDATE SET
          mod_identifier   = excluded.mod_identifier,
          description      = excluded.description,
          description_html = excluded.description_html,
          background_url   = excluded.background_url,
          downloads        = excluded.downloads,
          followers        = excluded.followers,
          fetched_at       = excluded.fetched_at`
      )
      .run(entry)
  }

  getSpaceDockCache(spacedockId: number): SpaceDockCacheRow | undefined {
    return this.db
      .prepare(`SELECT * FROM spacedock_cache WHERE spacedock_id = @spacedock_id`)
      .get({ spacedock_id: spacedockId }) as SpaceDockCacheRow | undefined
  }

  getStaleSpaceDockEntries(olderThanMs: number): SpaceDockCacheRow[] {
    const cutoff = Date.now() - olderThanMs
    return this.db
      .prepare(`SELECT * FROM spacedock_cache WHERE fetched_at < @cutoff`)
      .all({ cutoff }) as SpaceDockCacheRow[]
  }

  createProfile(profile: ProfileRow): void {
    this.db
      .prepare(
        `INSERT INTO profiles (id, name, ksp_path, ksp_version, created_at, updated_at)
         VALUES (@id, @name, @ksp_path, @ksp_version, @created_at, @updated_at)`
      )
      .run(profile)
  }

  getProfiles(): ProfileRow[] {
    return this.db
      .prepare(`SELECT * FROM profiles ORDER BY name`)
      .all() as ProfileRow[]
  }

  getProfile(id: string): ProfileRow | undefined {
    return this.db
      .prepare(`SELECT * FROM profiles WHERE id = @id`)
      .get({ id }) as ProfileRow | undefined
  }

  deleteProfile(id: string): void {
    this.db.prepare(`DELETE FROM profiles WHERE id = @id`).run({ id })
  }

  addInstalledMod(entry: InstalledModRow): void {
    this.db
      .prepare(
        `INSERT INTO installed_mods (profile_id, identifier, version, installed_files, installed_at, is_dependency)
         VALUES (@profile_id, @identifier, @version, @installed_files, @installed_at, @is_dependency)
         ON CONFLICT(profile_id, identifier) DO UPDATE SET
           version         = excluded.version,
           installed_files = excluded.installed_files,
           installed_at    = excluded.installed_at,
           is_dependency   = excluded.is_dependency`
      )
      .run({ ...entry, is_dependency: entry.is_dependency ?? 0 })
  }

  removeInstalledMod(profileId: string, identifier: string): void {
    this.db
      .prepare(`DELETE FROM installed_mods WHERE profile_id = @profile_id AND identifier = @identifier`)
      .run({ profile_id: profileId, identifier })
  }

  getInstalledMods(profileId: string): InstalledModRow[] {
    return this.db
      .prepare(`SELECT * FROM installed_mods WHERE profile_id = @profile_id ORDER BY identifier`)
      .all({ profile_id: profileId }) as InstalledModRow[]
  }

  /** Get all mod_versions rows that declare provides (non-null). */
  getModVersionsWithProvides(): Array<{ identifier: string; version: string; provides: string }> {
    return this.db
      .prepare(`SELECT identifier, version, provides FROM mod_versions WHERE provides IS NOT NULL`)
      .all() as Array<{ identifier: string; version: string; provides: string }>
  }

  // --- Repositories ---

  getRepositories(): RepositoryRow[] {
    return this.db
      .prepare(`SELECT * FROM repositories ORDER BY priority, name`)
      .all() as RepositoryRow[]
  }

  upsertRepository(repo: RepositoryRow): void {
    this.db
      .prepare(
        `INSERT INTO repositories (id, name, url, enabled, priority)
         VALUES (@id, @name, @url, @enabled, @priority)
         ON CONFLICT(id) DO UPDATE SET
           name     = excluded.name,
           url      = excluded.url,
           enabled  = excluded.enabled,
           priority = excluded.priority`
      )
      .run(repo)
  }

  deleteRepository(id: string): void {
    this.db.prepare(`DELETE FROM repositories WHERE id = @id`).run({ id })
  }

  // --- Settings ---

  getSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = @key`).get({ key }) as { value: string } | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (@key, @value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run({ key, value })
  }

  getModCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM mods`).get() as { count: number }
    return row.count
  }

  getDistinctKspVersions(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT ksp_version FROM mods
      WHERE ksp_version IS NOT NULL AND ksp_version != '' AND ksp_version != 'any'
    `).all() as { ksp_version: string }[]
    return rows
      .map(r => r.ksp_version)
      .filter(v => /^\d+(\.\d+)*$/.test(v))
      .sort((a, b) => compareVersionStrings(b, a))
  }

  runInTransaction(fn: () => void): void {
    this.db.transaction(fn)()
  }

  close(): void {
    this.db.close()
  }
}
