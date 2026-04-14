import { useEffect, useState } from 'react'
import { useProfileStore } from '../../stores/profile-store'
import { useInstallStore } from '../../stores/install-store'
import { api } from '../../lib/ipc'

interface AuditUpdate { identifier: string; name: string; installedVersion: string; latestVersion: string }
interface AuditMissingDep { identifier: string; name: string; missingDep: string }
interface AuditIncompat { identifier: string; name: string; reason: string }
interface AuditOrphan { identifier: string; name: string }

interface AuditResult {
  updates: AuditUpdate[]
  missingDeps: AuditMissingDep[]
  incompatible: AuditIncompat[]
  orphans: AuditOrphan[]
}

function Section({ title, icon, count, children }: { title: string; icon: string; count: number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2 pb-2 border-b border-[rgba(99,102,241,0.12)]">
        <span className="text-base">{icon}</span>
        <h3 className="text-base font-semibold text-white">{title}</h3>
        {count > 0 && (
          <span className="ml-auto text-xs bg-[rgba(99,102,241,0.2)] text-[#a78bfa] px-2 py-0.5 rounded-full">
            {count}
          </span>
        )}
      </div>
      {count === 0 ? (
        <p className="text-sm text-[rgba(148,163,184,0.5)] py-2">All clear.</p>
      ) : (
        <div className="rounded-xl bg-[rgba(255,255,255,0.03)] border border-[rgba(99,102,241,0.12)] divide-y divide-[rgba(99,102,241,0.06)]">
          {children}
        </div>
      )}
    </section>
  )
}

export function AuditView() {
  const { activeProfileId, uninstallMod } = useProfileStore()
  const { requestInstall } = useInstallStore()
  const [audit, setAudit] = useState<AuditResult | null>(null)
  const [loading, setLoading] = useState(false)

  const runAudit = async () => {
    if (!activeProfileId) return
    setLoading(true)
    try {
      const result = await api.profiles.audit(activeProfileId)
      setAudit(result ?? { updates: [], missingDeps: [], incompatible: [], orphans: [] })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { runAudit() }, [activeProfileId])

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto w-full px-6 py-8 flex flex-col gap-8">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white">Audit</h2>
            <p className="text-sm text-[rgba(148,163,184,0.6)] mt-0.5">
              Review issues with your installed mods
            </p>
          </div>
          <button
            onClick={runAudit}
            disabled={loading || !activeProfileId}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-[rgba(99,102,241,0.8)] hover:bg-[rgba(99,102,241,1)] text-white border border-[rgba(99,102,241,0.4)] transition-colors cursor-pointer disabled:opacity-40"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="animate-spin inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full" />
                Scanning...
              </span>
            ) : 'Re-scan'}
          </button>
        </div>

        {!activeProfileId && (
          <p className="text-sm text-[rgba(148,163,184,0.5)]">No active profile selected.</p>
        )}

        {audit && (
          <>
            <Section title="Updates Available" icon="⬆" count={audit.updates.length}>
              {audit.updates.map(u => (
                <div key={u.identifier} className="flex items-center gap-4 px-5 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{u.name}</p>
                    <p className="text-xs text-[rgba(148,163,184,0.5)]">
                      {u.installedVersion} → <span className="text-[#34d399]">{u.latestVersion}</span>
                    </p>
                  </div>
                  <button
                    onClick={() => requestInstall([u.identifier])}
                    className="text-xs px-3 py-1.5 rounded-lg bg-[rgba(52,211,153,0.15)] hover:bg-[rgba(52,211,153,0.3)] text-[#34d399] border border-[rgba(52,211,153,0.2)] transition-colors cursor-pointer flex-shrink-0"
                  >
                    Update
                  </button>
                </div>
              ))}
            </Section>

            <Section title="Missing Dependencies" icon="⚠" count={audit.missingDeps.length}>
              {audit.missingDeps.map(m => (
                <div key={`${m.identifier}-${m.missingDep}`} className="flex items-center gap-4 px-5 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{m.name}</p>
                    <p className="text-xs text-[rgba(148,163,184,0.5)]">
                      Requires: <span className="text-[#fbbf24]">{m.missingDep}</span>
                    </p>
                  </div>
                  <button
                    onClick={() => requestInstall([m.missingDep])}
                    className="text-xs px-3 py-1.5 rounded-lg bg-[rgba(99,102,241,0.15)] hover:bg-[rgba(99,102,241,0.3)] text-[#a78bfa] border border-[rgba(99,102,241,0.2)] transition-colors cursor-pointer flex-shrink-0"
                  >
                    Install
                  </button>
                </div>
              ))}
            </Section>

            <Section title="Incompatible Mods" icon="🚫" count={audit.incompatible.length}>
              {audit.incompatible.map(m => (
                <div key={m.identifier} className="flex items-center gap-4 px-5 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{m.name}</p>
                    <p className="text-xs text-[rgba(148,163,184,0.5)] truncate">{m.reason}</p>
                  </div>
                  <button
                    onClick={() => uninstallMod(m.identifier).then(runAudit)}
                    className="text-xs px-3 py-1.5 rounded-lg bg-[rgba(239,68,68,0.1)] hover:bg-[rgba(239,68,68,0.25)] text-[#ef4444] border border-[rgba(239,68,68,0.15)] transition-colors cursor-pointer flex-shrink-0"
                  >
                    Uninstall
                  </button>
                </div>
              ))}
            </Section>

            <Section title="Orphan Dependencies" icon="🔗" count={audit.orphans.length}>
              {audit.orphans.map(o => (
                <div key={o.identifier} className="flex items-center gap-4 px-5 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{o.name}</p>
                    <p className="text-xs text-[rgba(148,163,184,0.5)]">
                      Auto-installed dependency no longer needed
                    </p>
                  </div>
                  <button
                    onClick={() => uninstallMod(o.identifier).then(runAudit)}
                    className="text-xs px-3 py-1.5 rounded-lg bg-[rgba(239,68,68,0.1)] hover:bg-[rgba(239,68,68,0.25)] text-[#ef4444] border border-[rgba(239,68,68,0.15)] transition-colors cursor-pointer flex-shrink-0"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </Section>
          </>
        )}
      </div>
    </div>
  )
}
