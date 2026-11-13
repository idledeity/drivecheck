/**
 * Puts text on the clipboard; resolves false if the browser refused.
 *
 * The async Clipboard API only exists on secure pages (https, localhost).
 * Over plain http on the LAN it's missing, so this falls back to the old
 * select-a-hidden-textarea-and-copy route, which still works there.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through: e.g. the page doesn't have focus.
    }
  }
  return copyWithTextarea(text)
}

function copyWithTextarea(text: string): boolean {
  const ta = document.createElement("textarea")
  ta.value = text
  ta.setAttribute("readonly", "")
  ta.style.position = "fixed"
  ta.style.opacity = "0"
  document.body.appendChild(ta)
  ta.select()
  try {
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    ta.remove()
  }
}
