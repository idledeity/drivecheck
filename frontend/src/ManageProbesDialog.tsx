import { useState } from "react"
import { createPortal } from "react-dom"
import { IconX, IconPlus, IconUpload } from "@tabler/icons-react"
import type { ConfigProp } from "./types"
import "./ManageProbesDialog.css"

interface ManageProbesDialogProps {
  category: string
  value: string[]
  onAdd: (path: string) => void
  onChoicesRefresh: (props: ConfigProp[]) => void
  onClose: () => void
}

// Dedicated dialog for everything beyond picking an already-discovered
// choice from a category's <select>: a free-text custom path, scaffolding a
// stub from a template, or uploading a file each get their own panel here
// instead of fighting for space in the row itself. Modeled on the
// ConfirmModal/RestartPromptModal scrim-card pattern in SettingsOverlay.tsx,
// just with more content — stays open after a successful add so the result
// is visible instead of immediately vanishing.
export default function ManageProbesDialog({ category, value, onAdd, onChoicesRefresh, onClose }: ManageProbesDialogProps) {
  const [customText, setCustomText] = useState("")
  const [customError, setCustomError] = useState<string | null>(null)

  const [templateName, setTemplateName] = useState("")
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [templateSuccess, setTemplateSuccess] = useState<string | null>(null)
  const [creatingFromTemplate, setCreatingFromTemplate] = useState(false)

  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const addCustomPath = () => {
    const trimmed = customText.trim()
    if (!trimmed) return
    if (value.includes(trimmed)) {
      setCustomError("Already in this list")
      return
    }
    setCustomError(null)
    onAdd(trimmed)
    setCustomText("")
  }

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

  return createPortal(
    <div className="confirm-scrim" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="manage-probes-card">
        <div className="mp-header">
          <h3>Manage {category} probes</h3>
          <button className="icon-btn" onClick={onClose} title="Close">
            <IconX size={16} />
          </button>
        </div>
        <div className="mp-body">
          <section className="mp-section">
            <h4>Add a probe</h4>
            <div className="mp-add-panel">
              <label className="mp-add-label">Custom path</label>
              <div className="mp-add-row">
                <input
                  className="ml-custom-input"
                  type="text"
                  placeholder="dotted.module.path"
                  value={customText}
                  onChange={e => { setCustomText(e.target.value); setCustomError(null) }}
                  onKeyDown={e => { if (e.key === "Enter") addCustomPath() }}
                />
                <button className="tinted-btn tint-cy" onClick={addCustomPath} disabled={!customText.trim()}>
                  <IconPlus size={13} /> Add
                </button>
              </div>
              {customError && <span className="ml-add-error">{customError}</span>}
            </div>
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
        </div>
      </div>
    </div>,
    document.body,
  )
}
