/**
 * 跨视图共享的 Alpine 方法混入。
 *
 * 各视图曾各自复制 `t / showToast / formatTokens` 三份完全相同的实现
 * (桥接根 adminApp 的语言与 toast)。新增视图直接 `...ViewHelpers` 展开,
 * 不要再复制。注意:
 * - `formatPercent` 各视图语义不同(usage 保留一位小数,guard 取整),不收敛。
 * - `formatTime` 回退语义不同(users/guard 为 "-",connections 为 ""),不收敛。
 */
const ViewHelpers = {
  t(key, params) {
    const app = document.querySelector("[x-data^=adminApp]")
    if (app) void Alpine.$data(app).lang
    return I18n.t(key, params)
  },

  showToast(msg, type) {
    const app = document.querySelector("[x-data^=adminApp]")
    if (app) Alpine.$data(app).showToast(msg, type)
  },

  formatTokens(tokens) {
    const numericTokens = Number(tokens || 0)
    if (numericTokens === 0) return "0"
    if (numericTokens >= 1000000) {
      return (numericTokens / 1000000).toFixed(1) + "M"
    }
    if (numericTokens >= 1000) {
      return (numericTokens / 1000).toFixed(1) + "K"
    }
    return numericTokens.toString()
  },
}
