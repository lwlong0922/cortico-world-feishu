/**
 * 飞书 World 的浏览器端面板:「会话」和「凭证」两个页签。
 *
 * 这里只写浏览器能直接跑的东西:不 import 框架模块、不碰 document.body、数据一律走 ctx.invoke。
 * 面板卸载时 host 会 abort、清 root,定时器用 ctx.interval 登记,自动停。
 */

const NAME_OUT = '我';
const SHELL_STYLE = 'width:100%;max-width:1120px;margin:0 auto;padding:0 0 24px;box-sizing:border-box;';

function wrapSheet(ui, root, title, desc) {
  const shell = ui.h('div');
  shell.style.cssText = SHELL_STYLE;
  const card = ui.sheet({ title, desc });
  shell.append(card.el);
  root.append(shell);
  return card.body;
}

function mount(ctx) {
  const { ui, root } = ctx;

  const body = wrapSheet(ui, root, '会话', '飞书上收发的每一句,按时间排;每 5 秒自己刷新一次。');

  const bar = ui.rowbar();
  body.append(bar);
  const pill = ui.pill('连接中');
  bar.append(pill);
  // 页面顶部那两个「今日收/今日回」徽标是扩展装载时算的,不会跟着变;这里现取现显。
  const counts = ui.pill('今日 —');
  bar.append(counts);
  const message = ui.msgline('飞书消息不在这里发,回复走 feishu_reply。');
  body.append(message);

  const log = ui.log({
    variant: 'conversation',
    max: 300,
    maxHeight: 'calc(100vh - 320px)',
    empty: '还没有消息。',
  });
  body.append(log.el);

  let lastKey = '';

  const render = (data) => {
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    // 进来的按发信人标名字:群里不一定只有主人在说话,不能全写成一个人。
    const fallback = String(data?.ownerName ?? '').trim() || '对方';
    const last = messages.at(-1);
    const key = `${messages.length}|${last?.messageId ?? ''}|${last?.ts ?? ''}`;
    if (key === lastKey) return; // 没新东西就不重画,免得阅读器跳走
    lastKey = key;

    log.clear();
    if (!messages.length) return;
    for (const m of messages) {
      const who = m?.dir === 'out' ? NAME_OUT : String(m?.who ?? '').trim() || fallback;
      const t = ui.fmt.clock(m?.ts);
      const text = String(m?.text ?? '').replace(/\s*\n\s*/g, ' ');
      log.append(`${t}  ${who}: ${text}`, m?.dir === 'out' ? 'plain' : undefined);
    }
    log.scrollToEnd();
  };

  const load = async () => {
    try {
      const data = await ctx.invoke('list');
      pill.textContent = data?.connected === true ? '已连接' : '未连接';
      const today = data?.today;
      counts.textContent = today
        ? `今日收 ${Number(today.received ?? 0)} · 今日回 ${Number(today.replies ?? 0)}`
        : '今日 —';
      const errText = String(data?.lastError ?? '').trim();
      message.textContent = errText || '飞书消息不在这里发，回复走 feishu_reply。';
      render(data);
    } catch (err) {
      lastKey = '';
      pill.textContent = '取不到';
      message.textContent = err instanceof Error ? err.message : String(err);
      log.clear();
      log.append(`读会话失败:${err instanceof Error ? err.message : String(err)}`, 'bad');
    }
  };

  void load();
  ctx.interval(() => void load(), 5000);
}

function mountSetup(ctx) {
  const { ui, root } = ctx;

  const body = wrapSheet(
    ui,
    root,
    '飞书应用凭证',
    '在飞书开放平台「凭证与基础信息」里拿 App ID / App Secret。存在本机 .env,页面只显示 App ID,Secret 存进去就不再显示。',
  );

  const status = ui.rowbar();
  body.append(status);

  const idInput = ui.input({ cls: 'mono grow', placeholder: 'cli_xxxxxxxxxxxxxxxx' });
  const secretInput = ui.input({ type: 'password', cls: 'mono grow', placeholder: '留空表示不改' });
  const save = ui.button('保存', { size: 'sm', variant: 'primary', onClick: () => void submit() });
  const msg = ui.msgline();
  msg.hidden = true;

  const idRow = ui.rowbar();
  idRow.append(idInput);
  const secretRow = ui.rowbar();
  secretRow.append(secretInput, save);
  body.append(idRow, secretRow, msg);

  const paint = (s) => {
    status.replaceChildren(
      ui.pill(s?.secretSet ? 'Secret 已设' : 'Secret 未设', s?.secretSet ? 'on' : 'off'),
      ui.pill(s?.connected ? '已连接' : s?.enabled ? '未连接' : '未启用', s?.connected ? 'on' : 'off'),
    );
    // App ID 只作回填参考;已经填过就别每次刷回来盖住正在输入的内容
    if (s?.appId && !idInput.value && document.activeElement !== idInput) idInput.placeholder = s.appId;
    const err = String(s?.lastError ?? '').trim();
    const note = String(s?.note ?? '').trim();
    const text = note && err ? `${note} · ${err}` : note || err;
    msg.hidden = !text;
    msg.textContent = text;
  };

  const load = async () => {
    try {
      paint(await ctx.invoke('state'));
    } catch (err) {
      msg.hidden = false;
      msg.textContent = err instanceof Error ? err.message : String(err);
    }
  };

  async function submit() {
    const appId = idInput.value.trim();
    const appSecret = secretInput.value.trim();
    if (!appId && !appSecret) {
      ui.toast('App ID 和 App Secret 至少填一项', 'bad');
      return;
    }
    const off = ui.disable(save, idInput, secretInput);
    try {
      const s = await ctx.invoke('save', [appId, appSecret]);
      secretInput.value = '';
      if (appId) idInput.value = '';
      paint(s);
      ui.toast(s?.connected ? '已连上' : '存好了');
    } catch (err) {
      msg.hidden = false;
      msg.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      off.dispose();
    }
  }

  void load();
  ctx.interval(() => void load(), 5000);
}

export default {
  panels: {
    chat: { mount },
    setup: { mount: mountSetup },
  },
};
