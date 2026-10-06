// Refresh only changed icons, once per frame, within the requesting view.
const pendingIconRoots = new Set()
let iconRefreshScheduled = false

function refreshAdminIcons(root = document) {
  if (!root || typeof lucide === "undefined") return
  for (const pending of pendingIconRoots) {
    if (pending.contains(root)) return
    if (root.contains(pending)) pendingIconRoots.delete(pending)
  }
  pendingIconRoots.add(root)
  if (iconRefreshScheduled) return
  iconRefreshScheduled = true
  requestAnimationFrame(flushAdminIcons)
}

function flushAdminIcons() {
  iconRefreshScheduled = false
  const roots = [...pendingIconRoots]
  pendingIconRoots.clear()
  for (const root of roots) {
    if (root.isConnected === false) continue
    const icons = [...root.querySelectorAll("[data-lucide]")].filter((el) => {
      const name = el.getAttribute("data-lucide")
      return (
        el.localName !== "svg" || el.getAttribute("data-rendered-icon") !== name
      )
    })
    if (!icons.length) continue
    // Lucide copies attributes to the SVG, including Alpine's bindings.
    for (const el of icons) {
      el.setAttribute("data-rendered-icon", el.getAttribute("data-lucide"))
    }
    lucide.createIcons({
      root: {
        querySelectorAll: (selector) =>
          selector === "[data-lucide]" ? icons : [],
      },
    })
  }
}
