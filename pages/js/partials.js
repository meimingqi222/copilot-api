/**
 * 异步 HTML partial 加载器。
 *
 * index.html 只保留各视图占位,重型模板(如 connections)拆到
 * pages/partials/*.html,经 /admin/static/* 按需加载。
 * Alpine v3 的 MutationObserver 会自动初始化注入的 x-data 树,
 * 因此加载完成后无需手动 Alpine.initTree。
 * 加载失败时显示静态错误(不依赖 i18n/Alpine)并可一键重试。
 */
async function loadPartial(el) {
  const url = `/admin/static/${el.dataset.partial}`
  try {
    const response = await fetch(url, { credentials: "same-origin" })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    el.innerHTML = await response.text()
  } catch (error) {
    console.error(`Failed to load partial ${url}:`, error)
    el.innerHTML =
      '<div class="empty-state py-20">'
      + '<p class="text-body text-[var(--apple-text-secondary)]">Failed to load this section. Please reload. / 该板块加载失败,请刷新重试。</p>'
      + '<button class="btn btn-secondary mt-4" onclick="location.reload()">Reload / 刷新</button>'
      + "</div>"
  }
}

for (const el of document.querySelectorAll("[data-partial]")) {
  void loadPartial(el)
}
