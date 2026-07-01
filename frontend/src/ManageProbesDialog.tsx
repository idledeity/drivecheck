import { useState } from "react"
import { createPortal } from "react-dom"
import { IconX, IconPlus, IconUpload, IconEye, IconDownload, IconTrash, IconArrowLeft } from "@tabler/icons-react"
import type { ConfigProp } from "./types"
import "./ManageProbesDialog.css"

interface ManageProbesDialogProps {
  category: string
  value: string[]
  choices: string[] | null
  onAdd: (path: string) => void
  onChange: (value: string[]) => void
  onChoicesRefresh: (props: ConfigProp[]) => void
  onClose: () => void
}

// Full dotted paths (e.g. "drives.collector.probes.vitals.smartctl_vitals")
// are too long to show as-is — the dialog's own header already says which
// category this is. Shows just the module name plus a native/custom tag;
// falls back to the full path untagged for anything that doesn't match
// either category-scoped shape, so nothing is ever hidden, just not always
// shortened. Mirrors the equivalent helper in SettingsOverlay.tsx (kept
// separate rather than shared, to avoid a circular import between the two).
function shortProbeLabel(path: string, category: string): string {
  const nativePrefix = `drives.collector.probes.${category}.`
  if (path.startsWith(nativePrefix)) return `${path.slice(nativePrefix.length)} (native)`
  const customPrefix = `${category}.`
  if (path.startsWith(customPrefix)) return `${path.slice(customPrefix.length)} (custom)`
  return path
}

function isNativeProbePath(path: string, category: string): boolean {
  return path.startsWith(`drives.collector.probes.${category}.`)
}

function downloadUrl(category: string, path: string): string {
  return `/api/probes/download?category=${encodeURIComponent(category)}&path=${encodeURIComponent(path)}`
}

// Dedicated dialog for everything beyond picking an already-discovered
// choice from a category's <select>: adding a probe (template or upload),
// and browsing/viewing/editing/downloading/deleting every probe already on
// disk for this category. Modeled on the ConfirmModal/RestartPromptModal
// scrim-card pattern in SettingsOverlay.tsx, just with more content — adds
// stay open after success so the result is visible instead of immediately
// vanishing; the probe list swaps to a detail panel in place rather than a
// second dialog.
export default function ManageProbesDialog({ category, value, choices, onAdd, onChange, onChoicesRefresh, onClose }: ManageProbesDialogProps) {
  const [templateName, setTemplateName] = useState("")
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [templateSuccess, setTemplateSuccess] = useState<string | null>(null)
  const [creatingFromTemplate, setCreatingFromTemplate] = useState(false)

  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const [detailPath, setDetailPath] = useState<string | null>(null)
  const [detailContent, setDetailContent] = useState("")
  const [detailOriginalContent, setDetailOriginalContent] = useState("")
  const [detailEditable, setDetailEditable] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [discardAndThen, setDiscardAndThen] = useState<(() => void) | null>(null)

  const detailDirty = detailEditable && detailContent !== detailOriginalContent

  const guardedExit = (action: () => void) => detailDirty ? setDiscardAndThen(() => action) : action()

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const createFromTemplate = async () => {
    const name = templateName.trim()
    if (!name) return
    setCreatingFromTemplate(true)
    setTemplateError(null)
    setTemplateSuccess(null)
    try {
      const res = await fetch("/api/probes/template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, name }),
      })
      const data = await res.json() as ConfigProp[] | { error: string }
      if (!res.ok) {
        setTemplateError("error" in data ? data.error : "Failed to create probe")
        return
      }
      onChoicesRefresh(data as ConfigProp[])
      onAdd(`${category}.${name}`)
      setTemplateSuccess(`Created ${category}.${name}`)
      setTemplateName("")
    } catch {
      setTemplateError("Network error")
    } finally {
      setCreatingFromTemplate(false)
    }
  }

  const uploadProbe = async () => {
    if (!uploadFile) return
    setUploading(true)
    setUploadError(null)
    setUploadSuccess(null)
    try {
      const body = new FormData()
      body.append("category", category)
      body.append("file", uploadFile)
      const res = await fetch("/api/probes/upload", { method: "POST", body })
      const data = await res.json() as ConfigProp[] | { error: string }
      if (!res.ok) {
        setUploadError("error" in data ? data.error : "Failed to upload probe")
        return
      }
      onChoicesRefresh(data as ConfigProp[])
      // Mirrors the backend's own stem derivation (secure_filename then drop
      // the .py suffix) for the common case of an already-clean filename —
      // if the server actually saved it under a different name, the upload
      // would have failed validation instead of succeeding here.
      const stem = uploadFile.name.replace(/\.py$/i, "")
      onAdd(`${category}.${stem}`)
      setUploadSuccess(`Uploaded ${category}.${stem}`)
      setUploadFile(null)
    } catch {
      setUploadError("Network error")
    } finally {
      setUploading(false)
    }
  }

  const openDetail = async (path: string) => {
    setDetailPath(path)
    setDetailContent("")
    setDetailOriginalContent("")
    setDetailLoading(true)
    setDetailError(null)
    setSaveError(null)
    try {
      const res = await fetch(`/api/probes/source?category=${encodeURIComponent(category)}&path=${encodeURIComponent(path)}`)
      const data = await res.json() as { content: string; editable: boolean } | { error: string }
      if (!res.ok || "error" in data) {
        setDetailError("error" in data ? data.error : "Failed to load probe source")
        return
      }
      setDetailContent(data.content)
      setDetailOriginalContent(data.content)
      setDetailEditable(data.editable)
    } catch {
      setDetailError("Network error")
    } finally {
      setDetailLoading(false)
    }
  }

  const closeDetail = () => {
    setDetailPath(null)
    setDetailContent("")
    setDetailOriginalContent("")
    setDetailEditable(false)
    setDetailError(null)
    setSaveError(null)
    setDiscardAndThen(null)
  }

  const saveDetail = async () => {
    if (!detailPath) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch("/api/probes/source", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, path: detailPath, content: detailContent }),
      })
      const data = await res.json() as ConfigProp[] | { error: string }
      if (!res.ok) {
        setSaveError("error" in data ? data.error : "Failed to save probe")
        return
      }
      onChoicesRefresh(data as ConfigProp[])
      setDetailOriginalContent(detailContent)
    } catch {
      setSaveError("Network error")
    } finally {
      setSaving(false)
    }
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch(`/api/probes/source?category=${encodeURIComponent(category)}&path=${encodeURIComponent(deleteTarget)}`, {
        method: "DELETE",
      })
      const data = await res.json() as ConfigProp[] | { error: string }
      if (!res.ok) {
        setDeleteError("error" in data ? data.error : "Failed to delete probe")
        return
      }
      onChoicesRefresh(data as ConfigProp[])
      if (value.includes(deleteTarget)) onChange(value.filter(p => p !== deleteTarget))
      if (detailPath === deleteTarget) closeDetail()
      setDeleteTarget(null)
    } catch {
      setDeleteError("Network error")
    } finally {
      setDeleting(false)
    }
  }

  return createPortal(
    <>
      <div className="confirm-scrim" onClick={e => e.target === e.currentTarget && guardedExit(onClose)}>
        <div className="manage-probes-card">
          <div className="mp-header">
            <h3>Manage {category} probes</h3>
            <button className="icon-btn" onClick={() => guardedExit(onClose)} title="Close">
              <IconX size={16} />
            </button>
          </div>
          <div className="mp-body">
            {detailPath ? (
              <section className="mp-section">
                <div className="mp-detail-header">
                  <button className="text-link-btn mp-back-btn" onClick={() => guardedExit(closeDetail)}>
                    <IconArrowLeft size={13} /> Back
                  </button>
                  <h4 className="mp-detail-title">{shortProbeLabel(detailPath, category)}</h4>
                </div>
                {detailLoading && <p className="mp-detail-loading">Loading…</p>}
                {detailError && <span className="ml-add-error">{detailError}</span>}
                {!detailLoading && !detailError && (
                  <>
                    <textarea
                      className="mp-source-textarea"
                      value={detailContent}
                      readOnly={!detailEditable}
                      spellCheck={false}
                      onChange={e => setDetailContent(e.target.value)}
                    />
                    <div className="mp-detail-actions">
                      <a className="tinted-btn tint-cy" href={downloadUrl(category, detailPath)} download>
                        <IconDownload size={13} /> Download
                      </a>
                      {detailEditable && (
                        <button className="tinted-btn tint-cy" onClick={saveDetail} disabled={saving}>
                          {saving ? "Saving…" : "Save"}
                        </button>
                      )}
                    </div>
                    {saveError && <span className="ml-add-error">{saveError}</span>}
                  </>
                )}
              </section>
            ) : (
              <>
                <section className="mp-section">
                  <h4>Add a probe</h4>
                  <div className="mp-add-panel">
                    <label className="mp-add-label">New probe from template</label>
                    <div className="mp-add-row">
                      <input
                        className="ml-custom-input"
                        type="text"
                        placeholder="probe_name"
                        value={templateName}
                        disabled={creatingFromTemplate}
                        onChange={e => { setTemplateName(e.target.value); setTemplateError(null); setTemplateSuccess(null) }}
                        onKeyDown={e => { if (e.key === "Enter") createFromTemplate() }}
                      />
                      <button className="tinted-btn tint-cy" onClick={createFromTemplate} disabled={creatingFromTemplate || !templateName.trim()}>
                        <IconPlus size={13} /> Create
                      </button>
                    </div>
                    {templateError && <span className="ml-add-error">{templateError}</span>}
                    {templateSuccess && <span className="mp-add-success">{templateSuccess}</span>}
                  </div>
                  <div className="mp-add-panel">
                    <label className="mp-add-label">Upload a file</label>
                    <div className="mp-add-row">
                      <input
                        className="ml-upload-input"
                        type="file"
                        accept=".py"
                        disabled={uploading}
                        onChange={e => { setUploadFile(e.target.files?.[0] ?? null); setUploadError(null); setUploadSuccess(null) }}
                      />
                      <button className="tinted-btn tint-cy" onClick={uploadProbe} disabled={uploading || !uploadFile}>
                        <IconUpload size={13} /> Upload
                      </button>
                    </div>
                    {uploadError && <span className="ml-add-error">{uploadError}</span>}
                    {uploadSuccess && <span className="mp-add-success">{uploadSuccess}</span>}
                  </div>
                </section>
                <section className="mp-section">
                  <h4>All probes</h4>
                  <ul className="mp-probe-list">
                    {(choices ?? []).map(path => {
                      const native = isNativeProbePath(path, category)
                      return (
                        <li key={path} className="mp-probe-row">
                          <span className="mp-probe-path" title={path}>{shortProbeLabel(path, category)}</span>
                          <div className="mp-probe-actions">
                            <button className="icon-btn" onClick={() => openDetail(path)} title={native ? "View source" : "View / edit source"}>
                              <IconEye size={13} />
                            </button>
                            <a className="icon-btn" href={downloadUrl(category, path)} download title="Download">
                              <IconDownload size={13} />
                            </a>
                            {!native && (
                              <button className="icon-btn" onClick={() => setDeleteTarget(path)} title="Delete">
                                <IconTrash size={13} />
                              </button>
                            )}
                          </div>
                        </li>
                      )
                    })}
                    {(choices ?? []).length === 0 && <li className="mp-probe-empty">No probes found.</li>}
                  </ul>
                </section>
              </>
            )}
          </div>
        </div>
      </div>
      {discardAndThen && (
        <div className="confirm-scrim" onClick={e => e.target === e.currentTarget && setDiscardAndThen(null)}>
          <div className="confirm-card">
            <p>Discard unsaved changes?</p>
            <div className="restart-confirm-actions">
              <button className="text-link-btn" onClick={() => setDiscardAndThen(null)}>Keep editing</button>
              <button className="tinted-btn tint-re" onClick={() => { closeDetail(); discardAndThen() }}>Discard</button>
            </div>
          </div>
        </div>
      )}
      {deleteTarget && (
        <div className="confirm-scrim" onClick={e => e.target === e.currentTarget && !deleting && setDeleteTarget(null)}>
          <div className="confirm-card">
            <p>Delete {shortProbeLabel(deleteTarget, category)}?</p>
            <p className="confirm-detail">This permanently removes the file from custom_probes/{category}/.</p>
            {deleteError && <span className="ml-add-error">{deleteError}</span>}
            <div className="restart-confirm-actions">
              <button className="text-link-btn" onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</button>
              <button className="tinted-btn tint-re" onClick={doDelete} disabled={deleting}>{deleting ? "Deleting…" : "Delete"}</button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body,
  )
}
