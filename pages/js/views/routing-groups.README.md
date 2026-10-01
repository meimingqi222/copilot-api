# Routing groups — dashboard wiring

`routing-groups.js` + `routing-groups.css` add one admin page over the routing
groups backend: list groups, create/edit one (members, rules, pick, fast,
levels, classifier), delete one, and see the `group/<id>` values that point at
a group so a user knows what to type as a model name.

Both files are new and self-contained. Nothing else in the dashboard is wired
yet, so the page is dead until the five steps below are done. Nothing here is
required by the server to keep working — skip a step and you get a missing page,
not a broken dashboard.

## What the module is (and is not)

It is **not** an ES module. Every view under `pages/js/views/` is a plain script
that defines a global factory (`modelAliasesView()`, `accountsView()`, …) and is
loaded with a bare `<script src>`. A view that used `export` would be a parse
error there, and even as a module its factory would not land on the global
object the markup looks names up on. `routingGroupsView()` follows that
convention exactly: it spreads the shared `ViewHelpers` (language bridge +
toasts), fetches through the shared API client, and renders every value with
`x-text` / `:value`, so group-supplied ids escape themselves — no HTML strings
are ever built.

Cross-checked against `model-aliases.js` for shape:

| Concern        | Convention used                                                          |
| -------------- | ------------------------------------------------------------------------ |
| Entry point    | global `routingGroupsView()` returning a data object                     |
| Shared helpers | `...ViewHelpers` → `this.t(...)`, `this.showToast(...)`                  |
| Fetching       | `API.routingGroups.*` (see step 5)                                       |
| Errors         | `catch (error) { this.showToast(error.message, "error") }`               |
| Delete confirm | `globalThis.confirm(this.t("routingGroups.deleteConfirm", { name }))`    |
| Icons          | `this.$nextTick(() => lucide.createIcons())` after the list/modal render |

## Step 1 — load the script and the stylesheet (`pages/index.html`)

In `<head>`, after the existing `traces.css` link:

```html
<link rel="stylesheet" href="/admin/static/css/routing-groups.css" />
```

At the bottom of the file, in the block of view scripts (after
`model-aliases.js`):

```html
<script src="/admin/static/js/views/routing-groups.js"></script>
```

## Step 2 — add the view markup (`pages/index.html`)

Sibling of the other view containers, anywhere inside `<main>` (next to the
model-aliases block reads best). Paste as-is; every class it uses is either a
theme primitive or defined in `routing-groups.css`.

```html
<!-- Routing Groups View -->
<div
  x-show="currentView === 'routing-groups'"
  x-data="routingGroupsView()"
  x-init="load()"
  class="routing-groups-view"
  style="display: none"
>
  <header class="flex justify-between items-center mb-8">
    <h2 class="text-headline" x-text="t('routingGroups.title')"></h2>
    <button @click="openCreate()" class="btn btn-primary">
      <i data-lucide="plus" class="w-4 h-4"></i>
      <span x-text="t('routingGroups.add')"></span>
    </button>
  </header>
  <p class="rg-subtitle" x-text="t('routingGroups.subtitle')"></p>
  <p x-show="loading" class="rg-empty" x-text="t('loading')"></p>
  <p
    x-show="!loading && !groups.length"
    class="rg-empty"
    x-text="t('routingGroups.empty')"
  ></p>

  <div class="rg-list">
    <template x-for="group in groups" :key="group.id">
      <div class="card rg-row">
        <div class="rg-row-head">
          <div class="rg-row-main">
            <p class="rg-row-title" x-text="group.name"></p>
            <p class="rg-row-meta">
              <span class="rg-model-id" x-text="modelName(group)"></span>
              <button
                class="btn-icon rg-copy"
                @click="copy(modelName(group))"
                :title="t('copy')"
              >
                <i data-lucide="copy" class="w-4 h-4"></i>
              </button>
            </p>
          </div>
          <div class="rg-row-actions">
            <button
              class="btn btn-secondary btn-small"
              @click="openEdit(group)"
              x-text="t('edit')"
            ></button>
            <button
              class="btn btn-danger btn-small"
              @click="remove(group)"
              x-text="t('delete')"
            ></button>
          </div>
        </div>

        <p class="rg-row-meta" x-text="groupSummary(group)"></p>

        <div class="rg-members">
          <template x-for="member in group.members" :key="member">
            <span
              class="rg-member"
              :class="{ fast: isFastMember(group, member) }"
              x-text="member"
            ></span>
          </template>
        </div>

        <div x-show="group.pick" class="rg-pick-line" x-cloak>
          <span class="rg-field-label" x-text="t('routingGroups.pick')"></span>
          <span class="rg-member" x-text="group.pick"></span>
        </div>

        <div class="rg-rule-list" x-show="group.rules.length" x-cloak>
          <template x-for="(rule, index) in group.rules" :key="index">
            <div class="rg-rule-row">
              <span class="rg-rule-index" x-text="index + 1"></span>
              <span class="rg-rule-use" x-text="rule.use"></span>
              <span class="rg-rule-when" x-text="ruleSummary(rule)"></span>
            </div>
          </template>
        </div>

        <div class="rg-refs">
          <span
            class="rg-refs-label"
            x-text="t('routingGroups.references')"
          ></span>
          <template x-for="ref in referencesFor(group)" :key="ref">
            <span class="rg-ref" x-text="ref"></span>
          </template>
          <span
            x-show="!referencesFor(group).length && !referencesError"
            class="rg-refs-empty"
            x-text="t('routingGroups.referencesEmpty')"
          ></span>
          <span
            x-show="referencesError"
            class="rg-refs-error"
            :title="referencesError"
            x-text="t('routingGroups.referencesUnavailable')"
          ></span>
        </div>
      </div>
    </template>
  </div>

  <datalist id="rg-agent-options">
    <template x-for="agent in agentOptions" :key="agent">
      <option :value="agent"></option>
    </template>
  </datalist>

  <div
    x-show="showModal"
    class="modal-overlay"
    @click.self="closeModal()"
    x-cloak
  >
    <div class="modal rg-modal">
      <div class="modal-header">
        <h3
          class="text-title-3"
          x-text="editingId ? t('routingGroups.edit') : t('routingGroups.add')"
        ></h3>
        <button @click="closeModal()" class="btn-icon">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>
      </div>
      <div class="modal-body space-y-5">
        <div class="rg-grid">
          <div class="rg-field">
            <label class="form-label" x-text="t('routingGroups.id')"></label>
            <input
              class="form-input"
              x-model="form.id"
              :disabled="editingId !== null"
              :placeholder="t('routingGroups.idPlaceholder')"
            />
            <p class="rg-hint" x-text="t('routingGroups.idHint')"></p>
          </div>
          <div class="rg-field">
            <label class="form-label" x-text="t('routingGroups.name')"></label>
            <input class="form-input" x-model="form.name" />
          </div>
        </div>

        <div class="rg-section">
          <span
            class="rg-section-title"
            x-text="t('routingGroups.members')"
          ></span>
          <p class="rg-hint" x-text="t('routingGroups.membersHint')"></p>
          <template x-for="(member, index) in form.members" :key="index">
            <div class="rg-repeat">
              <input
                class="form-input"
                x-model="form.members[index]"
                :placeholder="t('routingGroups.membersPlaceholder')"
              />
              <label class="rg-check" :title="t('routingGroups.fastHint')">
                <input
                  type="checkbox"
                  :checked="form.fastFlags[index]"
                  @change="toggleFast(index)"
                />
                <span x-text="t('routingGroups.fast')"></span>
              </label>
              <div class="rg-repeat-actions">
                <button
                  class="btn-icon"
                  @click="removeMember(index)"
                  :title="t('routingGroups.removeMember')"
                >
                  <i data-lucide="trash-2" class="w-4 h-4"></i>
                </button>
              </div>
            </div>
          </template>
          <button
            class="btn btn-secondary btn-small self-start"
            @click="addMember()"
            x-text="t('routingGroups.addMember')"
          ></button>
        </div>

        <div class="rg-section">
          <span
            class="rg-section-title"
            x-text="t('routingGroups.pick')"
          ></span>
          <div class="rg-field">
            <select class="form-input" x-model="form.pick">
              <option value="" x-text="t('routingGroups.pickNone')"></option>
              <template x-for="member in memberChoices()" :key="member">
                <option :value="member" x-text="member"></option>
              </template>
            </select>
            <p class="rg-hint" x-text="t('routingGroups.pickHint')"></p>
          </div>
        </div>

        <div class="rg-section">
          <div class="rg-rule-head">
            <span
              class="rg-section-title"
              x-text="t('routingGroups.rules')"
            ></span>
            <button
              class="btn btn-secondary btn-small"
              @click="addRule()"
              x-text="t('routingGroups.addRule')"
            ></button>
          </div>
          <p class="rg-hint" x-text="t('routingGroups.rulesHint')"></p>
          <template x-for="(rule, index) in form.rules" :key="index">
            <div class="rg-rule">
              <div class="rg-rule-head">
                <span
                  class="rg-rule-head-title"
                  x-text="t('routingGroups.rule.title', { index: index + 1 })"
                ></span>
                <div class="rg-rule-actions">
                  <button
                    class="btn-icon"
                    @click="moveRule(index, -1)"
                    :title="t('routingGroups.moveUp')"
                  >
                    <i data-lucide="arrow-up" class="w-4 h-4"></i>
                  </button>
                  <button
                    class="btn-icon"
                    @click="moveRule(index, 1)"
                    :title="t('routingGroups.moveDown')"
                  >
                    <i data-lucide="arrow-down" class="w-4 h-4"></i>
                  </button>
                  <button
                    class="btn-icon"
                    @click="removeRule(index)"
                    :title="t('routingGroups.removeRule')"
                  >
                    <i data-lucide="trash-2" class="w-4 h-4"></i>
                  </button>
                </div>
              </div>

              <div class="rg-rule-grid">
                <div class="rg-field">
                  <label
                    class="form-label"
                    x-text="t('routingGroups.rule.use')"
                  ></label>
                  <select class="form-input" x-model="rule.use">
                    <option
                      value=""
                      x-text="t('routingGroups.rule.usePlaceholder')"
                    ></option>
                    <template x-for="member in memberChoices()" :key="member">
                      <option :value="member" x-text="member"></option>
                    </template>
                  </select>
                </div>
                <div class="rg-field">
                  <label
                    class="form-label"
                    x-text="t('routingGroups.rule.tokens')"
                  ></label>
                  <input
                    class="form-input"
                    type="number"
                    min="0"
                    x-model="rule.tokens"
                  />
                </div>
                <div class="rg-field">
                  <label
                    class="form-label"
                    x-text="t('routingGroups.rule.effort')"
                  ></label>
                  <select class="form-input" x-model="rule.effort">
                    <option value="" x-text="t('routingGroups.any')"></option>
                    <option
                      value="on"
                      x-text="t('routingGroups.rule.effortOn')"
                    ></option>
                    <template x-for="level in effortLevels" :key="level">
                      <option :value="level" x-text="level"></option>
                    </template>
                  </select>
                </div>
                <div class="rg-field">
                  <label
                    class="form-label"
                    x-text="t('routingGroups.rule.images')"
                  ></label>
                  <select class="form-input" x-model="rule.images">
                    <option value="" x-text="t('routingGroups.any')"></option>
                    <option value="true" x-text="t('yes')"></option>
                    <option value="false" x-text="t('no')"></option>
                  </select>
                </div>
                <div class="rg-field">
                  <label
                    class="form-label"
                    x-text="t('routingGroups.rule.compact')"
                  ></label>
                  <select class="form-input" x-model="rule.compact">
                    <option value="" x-text="t('routingGroups.any')"></option>
                    <option value="true" x-text="t('yes')"></option>
                    <option value="false" x-text="t('no')"></option>
                  </select>
                </div>
                <div class="rg-field">
                  <label
                    class="form-label"
                    x-text="t('routingGroups.rule.agents')"
                  ></label>
                  <input
                    class="form-input"
                    list="rg-agent-options"
                    x-model="rule.agents"
                    :placeholder="t('routingGroups.rule.agentsPlaceholder')"
                  />
                </div>
                <div class="rg-field">
                  <label
                    class="form-label"
                    x-text="t('routingGroups.rule.intent')"
                  ></label>
                  <input class="form-input" x-model="rule.intent" />
                </div>
              </div>

              <div class="rg-field">
                <label class="rg-check">
                  <input type="checkbox" x-model="rule.timeEnabled" />
                  <span x-text="t('routingGroups.rule.time')"></span>
                </label>
                <div class="rg-window mt-2" x-show="rule.timeEnabled" x-cloak>
                  <input
                    class="form-input"
                    type="time"
                    x-model="rule.timeFrom"
                  />
                  <span class="rg-field-label">–</span>
                  <input class="form-input" type="time" x-model="rule.timeTo" />
                  <div class="rg-days">
                    <template x-for="day in dayNames" :key="day">
                      <label class="rg-day">
                        <input
                          type="checkbox"
                          :checked="ruleHasDay(rule, day)"
                          @change="toggleRuleDay(rule, day)"
                        />
                        <span x-text="day"></span>
                      </label>
                    </template>
                  </div>
                </div>
                <p
                  class="rg-hint"
                  x-text="t('routingGroups.rule.timeHint')"
                ></p>
              </div>
            </div>
          </template>
        </div>

        <div class="rg-section">
          <span
            class="rg-section-title"
            x-text="t('routingGroups.levels')"
          ></span>
          <p class="rg-hint" x-text="t('routingGroups.levelsHint')"></p>
          <div class="rg-levels">
            <template x-for="level in effortChoices" :key="level">
              <label class="rg-day">
                <input
                  type="checkbox"
                  :checked="isLevelSelected(level)"
                  @change="toggleLevel(level)"
                />
                <span x-text="level"></span>
              </label>
            </template>
          </div>
        </div>

        <div class="rg-section">
          <span
            class="rg-section-title"
            x-text="t('routingGroups.classifier')"
          ></span>
          <div class="rg-grid">
            <div class="rg-field">
              <label
                class="form-label"
                x-text="t('routingGroups.classifierProvider')"
              ></label>
              <input class="form-input" x-model="form.classifier.provider" />
            </div>
            <div class="rg-field">
              <label
                class="form-label"
                x-text="t('routingGroups.classifierModel')"
              ></label>
              <input class="form-input" x-model="form.classifier.model" />
            </div>
          </div>
          <p class="rg-hint" x-text="t('routingGroups.classifierHint')"></p>
        </div>
      </div>
      <div class="modal-footer">
        <button
          class="btn btn-secondary"
          @click="closeModal()"
          x-text="t('cancel')"
        ></button>
        <button
          class="btn btn-primary"
          @click="save()"
          :disabled="saving"
          x-text="t('save')"
        ></button>
      </div>
    </div>
  </div>
</div>
```

## Step 3 — register the view (`pages/js/views/app.js`)

Add `"routing-groups"` to `validViews` (hash routing: `#routing-groups`):

```js
    validViews: [
      "accounts",
      "connections",
      "model-aliases",
      "routing-groups",
      // …
    ],
```

Add a sidebar entry to `navItems`, e.g. after the model aliases item:

```js
        {
          id: "routing-groups",
          icon: "git-branch",
          label: this.t("nav.routingGroups"),
        },
```

`app.js` owns `navItems`; `index.html` renders them in a loop, so no nav markup
edit is needed.

## Step 4 — translations (`pages/js/i18n.js`)

Both language blocks (`translations.zh` and `translations.en`) use the same
keys. Values below are the ones the page was written against; group them
wherever the file already groups views.

```js
      "nav.routingGroups": "路由组",
      "routingGroups.title": "路由组",
      "routingGroups.subtitle":
        "路由组把若干个成员(provider/model)按优先级放在一起,请求命中某条规则时,该规则指定的成员排到最前面。把 group/<id> 当模型名发给接口即可使用某个组。",
      "routingGroups.add": "新建路由组",
      "routingGroups.edit": "编辑路由组",
      "routingGroups.empty": "还没有路由组",
      "routingGroups.saved": "路由组已保存",
      "routingGroups.deleted": "路由组已删除",
      "routingGroups.deleteConfirm": "确定删除路由组「{name}」吗?",
      "routingGroups.invalid": "无法保存:",
      "routingGroups.copyFailed": "复制失败,请手动选中复制",
      "routingGroups.id": "ID",
      "routingGroups.idPlaceholder": "例如 fast-or-cheap",
      "routingGroups.idHint":
        "客户端使用的模型名是 group/<ID>;已存在的组不能改 ID,需要先删除再新建。",
      "routingGroups.name": "名称",
      "routingGroups.members": "成员",
      "routingGroups.membersHint":
        "每个成员写成 provider/model,可追加 :low/:medium/:high/:xhigh/:max 指定思考强度,再加 :fast 表示优先快速变体(例如 vendor/model:high:fast)。顺序即优先级。",
      "routingGroups.membersPlaceholder": "provider/model 或 group/其他组ID",
      "routingGroups.addMember": "添加成员",
      "routingGroups.removeMember": "删除该成员",
      "routingGroups.pick": "默认成员",
      "routingGroups.pickNone": "不指定(按成员顺序)",
      "routingGroups.pickHint": "没有任何规则命中时排在最前面的成员。",
      "routingGroups.fast": "fast",
      "routingGroups.fastHint": "勾选后优先使用该成员的快速变体。",
      "routingGroups.rules": "规则",
      "routingGroups.rulesHint":
        "从上往下逐条判断,第一条命中的规则生效;一条规则里设置的条件同时满足才算命中。",
      "routingGroups.addRule": "添加规则",
      "routingGroups.removeRule": "删除该规则",
      "routingGroups.moveUp": "上移",
      "routingGroups.moveDown": "下移",
      "routingGroups.rule.title": "规则 {index}",
      "routingGroups.rule.use": "命中后先用",
      "routingGroups.rule.usePlaceholder": "选择成员",
      "routingGroups.rule.tokens": "最小 token 数",
      "routingGroups.rule.effort": "思考强度至少",
      "routingGroups.rule.effortOn": "只要开了思考(on)",
      "routingGroups.rule.images": "包含图片",
      "routingGroups.rule.compact": "压缩请求",
      "routingGroups.rule.agents": "调用方",
      "routingGroups.rule.agentsPlaceholder": "逗号分隔,例如 codex, claude",
      "routingGroups.rule.intent": "意图",
      "routingGroups.rule.time": "限制时间窗口",
      "routingGroups.rule.timeHint":
        "本地时间。起止相同表示全天;结束早于开始表示跨夜。不勾选星期即每天。",
      "routingGroups.any": "不限",
      "routingGroups.levels": "可用强度",
      "routingGroups.levelsHint": "该组允许被以哪些思考强度提供,从低到高;留空表示不限制。",
      "routingGroups.classifier": "意图分类",
      "routingGroups.classifierProvider": "分类 provider",
      "routingGroups.classifierModel": "分类 model",
      "routingGroups.classifierHint":
        "规则里用了「意图」时才需要,填 provider 与 model 两样;否则留空。",
      "routingGroups.references": "被引用",
      "routingGroups.referencesEmpty": "暂无引用",
      "routingGroups.referencesUnavailable": "引用信息不可用",
      "routingGroups.everyDay": "每天",
      "routingGroups.summary.counts": "{members} 个成员 · {rules} 条规则",
      "routingGroups.summary.tokens": "≥{value} tokens",
      "routingGroups.summary.images": "含图片",
      "routingGroups.summary.noImages": "不含图片",
      "routingGroups.summary.effort": "强度≥{value}",
      "routingGroups.summary.agents": "调用方 {value}",
      "routingGroups.summary.intent": "意图 {value}",
      "routingGroups.summary.compact": "压缩请求",
      "routingGroups.summary.notCompact": "非压缩请求",
      "routingGroups.summary.time": "{days} {from}–{to}",
      "routingGroups.summary.always": "没有条件(永不命中)",
      "routingGroups.problem.required": "{field} 不能为空",
      "routingGroups.problem.idShape": "ID 不能包含空格或「/」:{value}",
      "routingGroups.problem.membersRequired": "至少需要一个成员",
      "routingGroups.problem.memberShape": "成员必须写成 provider/model:{value}",
      "routingGroups.problem.duplicateMember": "成员重复:{value}",
      "routingGroups.problem.ruleUse": "规则 {index} 没有选择成员",
      "routingGroups.problem.ruleNotMember": "规则 {index} 的成员不在本组中:{value}",
      "routingGroups.problem.tokens": "规则 {index} 的 token 数不是数字",
      "routingGroups.problem.noConditions": "规则 {index} 没有设置任何条件,永远不会命中",
      "routingGroups.problem.timeShape": "规则 {index} 的时间窗口格式应为 HH:MM",
      "routingGroups.problem.pickNotMember": "默认成员不在本组中:{value}",
      "routingGroups.problem.classifier": "分类需要同时填写 provider 与 model",
```

English:

```js
      "nav.routingGroups": "Routing Groups",
      "routingGroups.title": "Routing Groups",
      "routingGroups.subtitle":
        "A group pools members (provider/model) in preference order; when a rule matches, the member it names moves to the front. Send group/<id> as the model name to use a group.",
      "routingGroups.add": "New group",
      "routingGroups.edit": "Edit group",
      "routingGroups.empty": "No routing groups yet",
      "routingGroups.saved": "Routing group saved",
      "routingGroups.deleted": "Routing group deleted",
      "routingGroups.deleteConfirm": "Delete routing group \"{name}\"?",
      "routingGroups.invalid": "Cannot save:",
      "routingGroups.copyFailed": "Copy failed — select the text manually",
      "routingGroups.id": "ID",
      "routingGroups.idPlaceholder": "e.g. fast-or-cheap",
      "routingGroups.idHint":
        "The model name a client sends is group/<ID>. An existing group cannot be renamed — delete it and create a new one.",
      "routingGroups.name": "Name",
      "routingGroups.members": "Members",
      "routingGroups.membersHint":
        "Write each member as provider/model, optionally with :low/:medium/:high/:xhigh/:max for reasoning effort and :fast to prefer the fast variant (e.g. vendor/model:high:fast). Order is preference.",
      "routingGroups.membersPlaceholder": "provider/model or group/other-group-id",
      "routingGroups.addMember": "Add member",
      "routingGroups.removeMember": "Remove this member",
      "routingGroups.pick": "Default member",
      "routingGroups.pickNone": "None (keep member order)",
      "routingGroups.pickHint": "Leads whenever no rule matches.",
      "routingGroups.fast": "fast",
      "routingGroups.fastHint": "Prefer this member's fast variant.",
      "routingGroups.rules": "Rules",
      "routingGroups.rulesHint":
        "Evaluated top to bottom; the first match wins, and a rule matches only when every condition it sets holds.",
      "routingGroups.addRule": "Add rule",
      "routingGroups.removeRule": "Remove this rule",
      "routingGroups.moveUp": "Move up",
      "routingGroups.moveDown": "Move down",
      "routingGroups.rule.title": "Rule {index}",
      "routingGroups.rule.use": "Then lead with",
      "routingGroups.rule.usePlaceholder": "Pick a member",
      "routingGroups.rule.tokens": "At least tokens",
      "routingGroups.rule.effort": "Effort at least",
      "routingGroups.rule.effortOn": "Any reasoning (on)",
      "routingGroups.rule.images": "Has images",
      "routingGroups.rule.compact": "Is a compaction",
      "routingGroups.rule.agents": "Calling agent",
      "routingGroups.rule.agentsPlaceholder": "Comma separated, e.g. codex, claude",
      "routingGroups.rule.intent": "Intent",
      "routingGroups.rule.time": "Restrict to a time window",
      "routingGroups.rule.timeHint":
        "Local time. Equal start and end means the whole day; an end earlier than the start crosses midnight. No day selected means every day.",
      "routingGroups.any": "Any",
      "routingGroups.levels": "Served levels",
      "routingGroups.levelsHint":
        "Reasoning levels this group may be served at, lowest first. Leave empty for no restriction.",
      "routingGroups.classifier": "Intent classifier",
      "routingGroups.classifierProvider": "Classifier provider",
      "routingGroups.classifierModel": "Classifier model",
      "routingGroups.classifierHint":
        "Only needed when a rule uses Intent: fill in both provider and model, or leave both empty.",
      "routingGroups.references": "Referenced by",
      "routingGroups.referencesEmpty": "No references",
      "routingGroups.referencesUnavailable": "References unavailable",
      "routingGroups.everyDay": "every day",
      "routingGroups.summary.counts": "{members} members · {rules} rules",
      "routingGroups.summary.tokens": "≥{value} tokens",
      "routingGroups.summary.images": "with images",
      "routingGroups.summary.noImages": "without images",
      "routingGroups.summary.effort": "effort ≥{value}",
      "routingGroups.summary.agents": "agent {value}",
      "routingGroups.summary.intent": "intent {value}",
      "routingGroups.summary.compact": "compaction",
      "routingGroups.summary.notCompact": "not a compaction",
      "routingGroups.summary.time": "{days} {from}–{to}",
      "routingGroups.summary.always": "no conditions (never matches)",
      "routingGroups.problem.required": "{field} is required",
      "routingGroups.problem.idShape": "ID must not contain whitespace or \"/\": {value}",
      "routingGroups.problem.membersRequired": "At least one member is required",
      "routingGroups.problem.memberShape": "A member must be provider/model: {value}",
      "routingGroups.problem.duplicateMember": "Duplicate member: {value}",
      "routingGroups.problem.ruleUse": "Rule {index} names no member",
      "routingGroups.problem.ruleNotMember": "Rule {index} names a member this group does not have: {value}",
      "routingGroups.problem.tokens": "Rule {index} has a non-numeric token count",
      "routingGroups.problem.noConditions": "Rule {index} sets no condition, so it never matches",
      "routingGroups.problem.timeShape": "Rule {index} needs a HH:MM time window",
      "routingGroups.problem.pickNotMember": "The default member is not part of this group: {value}",
      "routingGroups.problem.classifier": "A classifier needs both a provider and a model",
```

Global keys reused as-is: `loading`, `save`, `cancel`, `edit`, `delete`, `copy`,
`copySuccess`, `yes`, `no`.

## Step 5 — API client (`pages/js/api.js`)

The view calls `API.routingGroups.list / upsert / delete / references / meta`.
Add one block inside the `API` object, next to `modelAliases` (or anywhere
before the `auth` section):

```js
  // Routing groups
  routingGroups: {
    list: () => API.request("/routing-groups"),
    get: (id) => API.request(`/routing-groups/${encodeURIComponent(id)}`),
    upsert: (group) =>
      API.request("/routing-groups", { method: "POST", body: group }),
    update: (id, group) =>
      API.request(`/routing-groups/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: group,
      }),
    delete: (id) =>
      API.request(`/routing-groups/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    restore: (id) =>
      API.request(`/routing-groups/${encodeURIComponent(id)}/restore`, {
        method: "POST",
      }),
    replace: (groups) =>
      API.request("/routing-groups", { method: "PUT", body: { groups } }),
    references: () => API.request("/routing-groups/references"),
    hidden: () => API.request("/routing-groups/hidden"),
    lookup: (model) =>
      API.request(`/routing-groups/lookup?model=${encodeURIComponent(model)}`),
    meta: () => API.request("/routing-groups/meta"),
  },
```

`API.request` already prefixes `/admin/api`, so the page never mentions the
prefix itself. The view only uses `list`, `upsert`, `delete`, `restore`,
`references`, `hidden` and `meta`; `get`, `update` and `replace` are listed so
the whole surface sits in one place.

## Routes the page expects

Already-shipped admin API conventions apply (JSON in, `{ error }` + 4xx on bad
input, `204` on delete):

| Method | Path                                    | Answer the view handles                       |
| ------ | --------------------------------------- | --------------------------------------------- |
| GET    | `/admin/api/routing-groups`             | `{ groups: [...] }` — a bare array also works |
| POST   | `/admin/api/routing-groups`             | `{ group: {...} }` (upsert by `id`), `201`    |
| DELETE | `/admin/api/routing-groups/:id`         | `204`; `404` + `{ error }` when absent        |
| POST   | `/admin/api/routing-groups/:id/restore` | `204`; `404` when the id is not hidden        |
| GET    | `/admin/api/routing-groups/references`  | see below                                     |
| GET    | `/admin/api/routing-groups/hidden`      | `{ hidden: ["auto-…"] }`                      |
| GET    | `/admin/api/routing-groups/lookup`      | `{ model, reference }`; `404` without one     |
| GET    | `/admin/api/routing-groups/meta`        | optional hints                                |

`/references` is read defensively, so either shape works:

```json
{ "references": { "fast-or-cheap": ["group/fast-or-cheap", "acme/pro:high"] } }
```

```json
{
  "references": [
    {
      "group": "fast-or-cheap",
      "references": [{ "member": "group/fast-or-cheap", "via": "rules[0].use" }]
    }
  ]
}
```

A string is shown verbatim; an object is rendered as `member (via)` using
`member`/`value`/`model`/`use`/`from` and `via`/`source`/`kind`/`where`.
Numbers, unknown shapes and empty strings are dropped rather than rendered as
`[object Object]`.

`/meta` may announce `levels` / `efforts` and `agents` (strings or
`{ id | name | value }` records). They only widen the suggestion lists; if the
route 404s the page falls back to the built-in levels and shows nothing extra.
A failing `/references` shows "References unavailable" in place of the chips and
leaves the rest of the page working.

## Behaviour worth knowing

- **IDs are not editable for an existing group** (the input is disabled while
  editing) because the POST upserts by id — renaming would leave the old group
  behind. Delete and recreate instead.
- **Rules are ordered and the first match wins**, so each rule row has move
  up / move down. Order in the form is the order sent.
- **A rule must constrain something.** A rule that sets no condition can never
  match, so the page refuses to save it (the backend would store it as dead
  config). The message says which rule.
- **Members, `pick` and `fast` are checked against each other** before the
  request: a `pick` or a rule `use` that is not a member, a duplicate member,
  and a `time` window that is not `HH:MM` are all reported in one toast, so the
  user fixes them in one pass.
- **`group/<id>` is shown on every row** with a copy button. Nested group
  members (`group/other`) are legal member strings, and a group cannot list
  itself — the backend rejects that; the page surfaces the message.
- **Same-model routing needs no group.** The list contains stored custom groups
  only. Legacy `group/auto-*` references still resolve on demand for existing
  clients, without appearing in either the group list or `/v1/models`.
- **Public exposure is opt-in.** The editor's `expose` checkbox adds a custom
  `group/<id>` entry to `/v1/models`. It is off by default and round-trips through
  persistence. Same public model IDs stay deduplicated across connections.
- Unset conditions are omitted from the request body entirely rather than sent
  as `null`/`""`, which is what the store's validation expects.
- The `fast` flag is a checkbox on each member row; the chip for such a member
  is marked `fast` in the list.

## Verification

```
bun run typecheck
bun run lint:all
bunx oxlint pages/js/views/routing-groups.js
```

There is no test runner for the dashboard views, so the page is verified by
loading it: open `#routing-groups`, create a group with two members and one
time-windowed rule, confirm it appears with its `group/<id>` chip, then delete
it. `bun run typecheck` stays clean because `pages/` is plain JS outside the
`src` project graph.

## Runtime selection

Bare model IDs and custom groups use one route selector. Dedicated/native compatibility tiers precede explicit connection priority. The default strategy is quota-aware, with session affinity; explicitly configured fill-first and round-robin remain supported. Smart and usage flatten member candidates and select quota or least-used policy through that same selector. They respect connection priority, using healthy backups before spent primaries. Ties stay in candidate order. Evidence comes from current in-memory quota snapshots; routing does not fetch quota upstream.

Group affinity follows its configured mode (or global affinity when omitted, as the editor defaults). Both entry points retain low accounts for cache reuse, but release bindings at the spent threshold (98% used by default), on unavailability, or when explicit priority changes move the account out of the primary tier. Group bindings stay isolated from bare-model bindings. A matching rule still leads with its selected member. Order, rotate and manual use their prepared member order.

HTTP and Responses WS retries preserve group policy, session context and member suffixes. WS retries remain restricted to account-managed connections of the initial protocol. Trace member and effort/fast settings follow the actual chosen target.
