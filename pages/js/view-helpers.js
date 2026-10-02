/**
 * 跨视图共享的 Alpine 方法混入。
 *
 * 各视图曾各自复制 `t / showToast / formatTokens` 三份完全相同的实现
 * (桥接根 adminApp 的语言与 toast)。新增视图直接 `...ViewHelpers` 展开,
 * 不要再复制。
 */

const BRAND_ICON_MAP = {
  copilot: "githubcopilot",
  "github-copilot": "githubcopilot",
  claude: "claude-color",
  anthropic: "claude-color",
  codex: "codex-color",
  openai: "openai",
  antigravity: "antigravity-color",
  kimi: "kimi",
  moonshot: "kimi",
  xai: "xai",
  codebuddy: "workbuddy-color",
  "codebuddy-cn": "workbuddy-color",
  workbuddy: "workbuddy-color",
  "workbuddy-cn": "workbuddy-color",
  codebuff: "codex-color",
  windsurf: "windsurf",
  devin: "devin",
  swe: "devin",
  "mimo-aistudio": "mimocode",
  mimo: "mimocode",
  xiaomi: "mimocode",
  minimax: "minimax-color",
  "minimax-cn": "minimax-color",
  qoder: "qoder",
  factory: "factory",
  zcode: "zcode",
  "commandcode-plan": "commandcode",
  commandcode: "commandcode",
  zed: "zed",
  gemini: "gemini-color",
  google: "gemini-color",
  deepseek: "deepseek-color",
  qwen: "qwen-color",
  alibaba: "qwen-color",
  bailian: "qwen-color",
  zhipu: "zhipu-color",
  glm: "zhipu-color",
  siliconflow: "siliconcloud-color",
  siliconcloud: "siliconcloud-color",
  volcengine: "volcengine-color",
  doubao: "volcengine-color",
  stepfun: "stepfun-color",
  mistral: "mistral-color",
  groq: "groq",
  ollama: "ollama",
  openrouter: "openrouter",
  bedrock: "bedrock-color",
  azure: "azure-color",
  cloudflare: "cloudflare-color",
  together: "together-color",
  fireworks: "fireworks-color",
  modelscope: "modelscope-color",
  baiducloud: "baiducloud-color",
  qianfan: "baiducloud-color",
  tencentcloud: "tencentcloud-color",
  huaweicloud: "huaweicloud-color",
  zai: "zai",
}

const MODEL_FAMILY_ICONS = [
  { prefix: "claude", icon: "claude-color" },
  { prefix: "gpt", icon: "openai" },
  { prefix: "o1", icon: "openai" },
  { prefix: "o3", icon: "openai" },
  { prefix: "o4", icon: "openai" },
  { prefix: "codex", icon: "openai" },
  { prefix: "gemini", icon: "gemini-color" },
  { prefix: "gemma", icon: "gemini-color" },
  { prefix: "deepseek", icon: "deepseek-color" },
  { prefix: "grok", icon: "xai" },
  { prefix: "kimi", icon: "kimi" },
  { prefix: "moonshot", icon: "kimi" },
  { prefix: "glm", icon: "zhipu-color" },
  { prefix: "qwen", icon: "qwen-color" },
  { prefix: "qwq", icon: "qwen-color" },
  { prefix: "mistral", icon: "mistral-color" },
  { prefix: "codestral", icon: "mistral-color" },
  { prefix: "minimax", icon: "minimax-color" },
  { prefix: "mimo", icon: "mimocode" },
  { prefix: "xiaomi", icon: "mimocode" },
  { prefix: "step", icon: "stepfun-color" },
  { prefix: "doubao", icon: "volcengine-color" },
  { prefix: "codebuddy", icon: "workbuddy-color" },
  { prefix: "workbuddy", icon: "workbuddy-color" },
  { prefix: "swe", icon: "devin" },
  { prefix: "devin", icon: "devin" },
]

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

  resolveBrandIconName(provider, modelId) {
    const p = String(provider || "")
      .toLowerCase()
      .trim()
    if (p && BRAND_ICON_MAP[p]) {
      return BRAND_ICON_MAP[p]
    }
    const m = String(modelId || "")
      .toLowerCase()
      .trim()
    const slash = m.lastIndexOf("/")
    const model = slash >= 0 ? m.slice(slash + 1) : m
    for (const item of MODEL_FAMILY_ICONS) {
      if (model.startsWith(item.prefix)) {
        return item.icon
      }
    }
    if (p && Object.values(BRAND_ICON_MAP).includes(p)) {
      return p
    }
    return ""
  },

  brandIconHtml(provider, modelId, extraClass = "") {
    const iconName = this.resolveBrandIconName(provider, modelId)
    if (!iconName) {
      return `<i data-lucide="box" class="${extraClass}"></i>`
    }
    const isColor =
      iconName.endsWith("-color")
      || iconName === "crush"
      || iconName === "zcode"
      || iconName === "typesafe"
    const ext =
      iconName === "crush" || iconName === "zcode" || iconName === "typesafe" ?
        "png"
      : "svg"
    const src = `/admin/static/icons/${iconName}.${ext}`
    if (isColor) {
      return `<span class="brand-icon ${extraClass}"><img src="${src}" alt="" draggable="false" /></span>`
    }
    return `<span class="brand-icon ${extraClass}"><span class="mask" style="--i: url('${src}')"></span></span>`
  },
}
