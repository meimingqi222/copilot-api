// Desktop selectors and response fields follow magpie-community/plugins
// packages/doubao-work at 2f80fdc (see MAGPIE-LICENSE in this directory).
const library = String.raw`
const $ = (selector, root = document) => root.querySelector(selector);
const all = (selector, root = document) => [...root.querySelectorAll(selector)];
const test = (name) => $('[data-testid=' + name + ']');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (read) => {
  for (let i = 0; i < 50; i++) {
    const value = read();
    if (value) return value;
    await wait(100);
  }
  return null;
};
const press = (node) => {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
};
const dismiss = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const lines = (node) => node?.innerText?.split('\n').map((word) => word.trim()).filter(Boolean) ?? [];
const name = () => {
  const sidebar = test('sidebar_bottom');
  if (!sidebar || location.href.includes('from_logout') ||
    all('button, [role=button]', sidebar).some((b) => lines(b)[0] === '登录')) return '';
  const label = lines(sidebar)[0] || '';
  return label === '登录' ? '' : label;
};
const cloud = () => test('chat_input_action_mode')?.innerText.trim() === '云电脑';
const modelButton = () => test('chat_input_action_model');
const editor = () => $('.ProseMirror')?.editor;
const sends = () => all('[data-testid=send_message]');
const replies = () => all('[data-testid=receive_message]');
const clean = () => /^\/chat\/?$/.test(location.pathname) && !!editor() && !sends().length && !replies().length;
const message = (node) => {
  let fiber = node?.[Object.keys(node).find((key) => key.startsWith('__reactFiber'))];
  for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
    const msg = fiber.memoizedProps?.message;
    if (msg?.message_id !== undefined && Array.isArray(msg.content_blocks_v2)) return msg;
  }
  return null;
};
const rows = () => all('[role=menu] [role=menuitem]').filter((row) => row.getAttribute('aria-haspopup') !== 'menu');
const marketRow = (row) => !/自定义|自备|API Key/i.test(row.innerText);
const modelMatches = (text, label) => text === label || (text?.startsWith(label + ' ') &&
  /^(限时|优惠|小额|免费|新|热|推荐|hot|new|beta|[\d.]+\s*[x×倍]|[x×]\s*[\d.]+)/i.test(text.slice(label.length + 1).trim()));
`

function expression(body: string): string {
  return `(async () => {
    if (!/^(doubao|doubaowork|chrome):\\/\\/(doubao|doubaowork)-chat\\/chat(?:[/?#]|$)/.test(location.href))
      throw Error('Not a Doubao desktop chat page');
    ${library}
    ${body}
  })()`
}

export const pageState = expression("return { name: name(), cloud: cloud() };")

export const newTask = expression(`
  const entry = test('create_office_task_button');
  if (!entry || !name()) return false;
  (entry.querySelector('[role=button]') || entry).click();
  return !!(await until(clean));
`)

export const selectCloud = expression(`
  const mode = test('chat_input_action_mode');
  if (!mode || !clean() || !name()) return false;
  if (cloud()) return true;
  press(mode);
  const item = await until(() => all('[role=menuitem]').find((row) => lines(row)[0] === '云电脑'));
  if (!item || !clean() || !name()) return false;
  press(item);
  return !!(await until(() => clean() && cloud()));
`)

export const workMenu = expression(`
  if (!cloud() || !clean() || !name() || !modelButton()) return [];
  press(modelButton());
  await until(() => rows().length);
  const models = rows().filter(marketRow).map((row) => ({
    label: lines(row)[0], upgrade: row.innerText.includes('升级'),
  }));
  dismiss();
  return models;
`)

export function selectModel(label: string): string {
  return expression(`
    const label = ${JSON.stringify(label)};
    if (!clean() || !cloud() || !name() || !modelButton()) return 'unavailable';
    if (modelMatches(lines(modelButton())[0], label)) return 'selected';
    press(modelButton());
    const row = await until(() => {
      const candidates = rows().filter(marketRow);
      return candidates.find((e) => lines(e)[0] === label)
        || candidates.find((e) => modelMatches(lines(e)[0], label));
    });
    if (!row) { dismiss(); return 'missing'; }
    if (row.innerText.includes('升级')) { dismiss(); return 'upgrade'; }
    if (!clean() || !cloud() || !name()) return 'unavailable';
    press(row);
    return await until(() => modelMatches(lines(modelButton())[0], label)) ? 'selected' : 'unavailable';
  `)
}

export function selectEffort(level: string): string {
  return expression(`
    const level = ${JSON.stringify(level)};
    if (!clean() || !cloud() || !name() || !modelButton()) return false;
    if (lines(modelButton())[1] === level) return true;
    press(modelButton());
    const menu = await until(() => all('[role=menu] [aria-haspopup=menu]').find((row) => lines(row)[0] === '推理强度'));
    if (!menu) { dismiss(); return false; }
    for (const type of ['pointerenter', 'pointermove', 'pointerover'])
      menu.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'mouse' }));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const item = await until(() => rows().find((row) => lines(row)[0] === level));
    if (!item || !clean() || !cloud() || !name()) { dismiss(); return false; }
    press(item);
    return !!(await until(() => lines(modelButton())[1] === level));
  `)
}

export function fillPrompt(prompt: string, account: string): string {
  return expression(`
    if (!clean() || !cloud() || name() !== ${JSON.stringify(account)}) return false;
    dismiss();
    if (!clean() || !cloud() || name() !== ${JSON.stringify(account)}) return false;
    const paragraphs = ${JSON.stringify(prompt.split("\n"))}.map((text) => ({
      type: 'paragraph', content: text ? [{ type: 'text', text }] : [],
    }));
    return editor().chain().clearContent(true).insertContent(paragraphs).focus('end').run();
  `)
}

export function sendPrompt(
  prompt: string,
  account: string,
  model: string,
  effort?: string,
): string {
  // The last cloud/profile/task check and click must be in one synchronous
  // page turn. Never fall back to a generic Enter outside these guards.
  return expression(`
    const button = test('chat_input_send_button');
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true'
      || !clean() || !cloud() || name() !== ${JSON.stringify(account)}
      || !modelMatches(lines(modelButton())[0], ${JSON.stringify(model)})
      || (${JSON.stringify(effort ?? "")} && lines(modelButton())[1] !== ${JSON.stringify(effort ?? "")})
      || editor().getText({ blockSeparator: ${JSON.stringify("\n")} }) !== ${JSON.stringify(prompt)}) return false;
    button.click();
    return true;
  `)
}

export function readReply(prompt: string, account: string): string {
  return expression(`
    if (name() !== ${JSON.stringify(account)}) return { mismatched: true };
    const sent = sends();
    if (sent.length !== 1) return { sends: sent.length };
    const draft = message(sent[0]);
    const expected = ${JSON.stringify(prompt)};
    const parts = draft?.content_blocks_v2.map((block) => block.content?.text_block?.text)
      .filter((text) => typeof text === 'string') ?? [];
    const rendered = (sent[0].innerText || '').replace(/\\r\\n?/g, '\\n');
    if (parts.join('') !== expected && parts.join('\\n') !== expected && rendered !== expected)
      return { sends: 1, mismatched: true };
    const msg = message(replies().at(-1));
    if (!msg) return { sends: 1 };
    const thinking = new Set(msg.content_blocks_v2.filter((b) => b.block_type === 10040).map((b) => b.block_id));
    let text = '', reasoning = '';
    for (const block of msg.content_blocks_v2) {
      const part = block.content?.text_block?.text;
      if (block.block_type !== 10000 || typeof part !== 'string') continue;
      if (thinking.has(block.parent_id)) reasoning += part;
      else text += part;
    }
    const ext = msg.ext || {};
    return {
      sends: 1, id: String(msg.message_id || msg.unique_id || ''), text, reasoning,
      finished: ext.is_finish === '1' || !!msg.final_status?.session,
      failed: !!msg.error_details || (!!ext.finish_reason_chat && !/^succeed/i.test(ext.finish_reason_chat)),
      usage: ext.context_window_usage,
    };
  `)
}

export const briefList = expression(`
  if (!name()) return null;
  const endpoint = new URL('https://www.doubao.com/alice/slot/action_bar_v3/brief_list');
  const recent = performance.getEntriesByType('resource').map(({ name }) => new URL(name))
    .filter((url) => url.origin === endpoint.origin && url.pathname.startsWith('/alice/') && url.search);
  const own = recent.findLast((url) => url.pathname === endpoint.pathname);
  endpoint.search = (own || recent.at(-1))?.search || '';
  if (!own) { endpoint.searchParams.delete('msToken'); endpoint.searchParams.delete('a_bogus'); }
  const response = await fetch(endpoint, {
    method: 'POST', credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bot_id: '7338286299411103781', language_code: 'zh' }),
  });
  if (!response.ok) return null;
  const body = await response.json();
  return body.code === 0 ? body.data?.entry_list?.find((item) => item.action_bar_key === 'coco_deep_thinking')
    ?.active_switch_conf?.menu_conf_v2 ?? null : null;
`)

export const readQuota = expression(`
  if (!name()) return null;
  const response = await fetch('https://www.doubao.com/alice/commerce/sale/subscription/quota/summary/', {
    method: 'POST', credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/json' }, body: '{}',
  });
  return response.ok ? await response.json() : null;
`)
