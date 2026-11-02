// 飞书 World:用自建应用 + 长连接,把主人发来的消息推进 Persona 的上下文,
// 再通过 feishu_reply 把话发回飞书。同一个 Persona,不是第二个大脑。
//
// 注意:凭证只存在宿主的秘密配置里,任何工具回执都不回显 App Secret。

import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lark from '@larksuiteoapi/node-sdk';
import type {
  RunPhase,
  ToolDef,
  ToolOutcome,
  World,
  WorldHost,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';
import { nowIso } from 'cortico/core/util.ts';
import {
  FEISHU_CONFIG_GROUP,
  FEISHU_DEFAULTS,
  FEISHU_SECRET_APP_ID,
  FEISHU_SECRET_APP_SECRET,
  type FeishuConfigSection,
} from './config.ts';
import { FEISHU_TOOL_DECLS } from './tools.ts';

/**
 * 环境模板:role=envPrompt 的那份声明必须指向一个真实存在的文件,否则前缀里没有这一段。
 * 称呼和本机专属的补充都走配置(`worlds.feishu.ownerName` / `worlds.feishu.extraPrompt`),
 * 所以随包发布的这一份是通用的。
 */
const ENV = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 通讯录查不到时先记一小时,免得每条消息都再打一次。面板里清认人缓存会马上重查。 */
const MISS_TTL_MS = 60 * 60 * 1000;
/** 单张图片随消息内联等待的上限:快图随原消息一起上,慢图先放行文字、下完再补一条。 */
const IMAGE_INLINE_WAIT_MS = 1_500;
/** 单张图片下载总超时。 */
const IMAGE_FETCH_TIMEOUT_MS = 8_000;
/** 单个提交槽位的最大持有时间:防止某条消息卡死或 pushEvent 不返回导致整条提交链堵死。 */
const COMMIT_SLOT_TIMEOUT_MS = 5_000;
/** feishu_setup 等待长连接建好或报错的上限。 */
const CONNECT_WAIT_READY_MS = 4_000;
/** 群成员超过这个数时 roster 不再逐个补查部门,避免上百次串行请求卡死。 */
const ROSTER_DEPT_LOOKUP_MAX = 30;

/**
 * 表情回复的 emoji_type 换成看得懂的符号。飞书给的是大写英文键,
 * 对不上号的(自定义表情等)原样带上,不猜。
 */
const REACTION_FACES: Record<string, string> = {
  THUMBSUP: '👍',
  THUMBSDOWN: '👎',
  HEART: '❤️',
  SMILE: '😄',
  LAUGH: '😆',
  CRY: '😭',
  SOB: '😭',
  SURPRISED: '😮',
  THINKING: '🤔',
  OK: '👌',
  DONE: '✅',
  FIRE: '🔥',
  CLAP: '👏',
  MUSCLE: '💪',
  PRAY: '🙏',
  PARTY: '🎉',
  STRONGLY_AGREE: '👌',
  LOVE_IT: '❤️',
};

/**
 * 把 `@_user_1` 这类占位换成「@名字(open_id)」。
 * 飞书把被 @ 的人放在 message.mentions 里,名字也给,所以群里能知道叫的是谁;
 * 对不上号的保留一个 [@],别把整句吞掉。sender 的名字飞书不给,只有 open_id。
 */
function stripMentions(s: string, mentions?: any[]) {
  const map = new Map<string, string>();
  for (const m of mentions ?? []) {
    const key = String(m?.key ?? '');
    if (!key) continue;
    const name = String(m?.name ?? '');
    const id = String(m?.id?.open_id ?? m?.id?.user_id ?? '');
    map.set(key, `@${name || '未知'}${id ? `(${id})` : ''}`);
  }
  return s
    .replace(/@_user_\d+/g, (k) => map.get(k) ?? '[@]')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** 把飞书接口的错误说清楚:带上 code 和 msg,不然只看到一句 400 猜不出原因。 */
function describeErr(e: unknown): string {
  const anyErr = e as any;
  const data = anyErr?.response?.data;
  const code = data?.code ?? anyErr?.code;
  const msg = data?.msg ?? anyErr?.msg;
  if (code || msg) return `code=${code ?? '?'} ${msg ?? ''}`.trim();
  return e instanceof Error ? e.message : String(e);
}

/** 一条消息里所有能下的图:普通图片和富文本里夹的图。表情包不在这里,飞书不给下。 */
function imageKeys(message: any): string[] {
  const type = String(message?.message_type ?? '');
  let parsed: any = undefined;
  try {
    parsed = typeof message?.content === 'string' ? JSON.parse(message.content) : undefined;
  } catch {
    parsed = undefined;
  }
  const keys: string[] = [];
  const push = (k: unknown) => {
    const key = String(k ?? '');
    if (key && !keys.includes(key)) keys.push(key);
  };
  if (type === 'image') push(parsed?.image_key);
  // 表情包飞书接口明确不给下,去请求只会把 lastError 写成「收图失败」。
  if (type === 'post') {
    const blocks = parsed?.content ?? parsed?.zh_cn?.content ?? parsed?.en_us?.content;
    if (Array.isArray(blocks)) {
      for (const line of blocks) {
        if (!Array.isArray(line)) continue;
        for (const el of line) if (el?.tag === 'img') push(el?.image_key);
      }
    }
  }
  return keys;
}

/** 把飞书消息体拍平成一句可读的话;不认识的消息类型也不丢,标出来。 */
function messageText(message: any): string {
  const type = String(message?.message_type ?? '');
  let parsed: any = undefined;
  try {
    parsed = typeof message?.content === 'string' ? JSON.parse(message.content) : undefined;
  } catch {
    parsed = undefined;
  }
  if (type === 'text') {
    const raw = String(parsed?.text ?? '');
    const body = stripMentions(raw, message?.mentions);
    // 只有 @ 我、没写正文的消息不能丢——在群里那就是"叫一下"。
    return body || (/@_user_\d+/.test(raw) ? '[@]' : '');
  }
  if (type === 'post') {
    const lines: string[] = [];
    const blocks = parsed?.content ?? parsed?.zh_cn?.content ?? parsed?.en_us?.content;
    if (Array.isArray(blocks)) {
      for (const line of blocks) {
        if (!Array.isArray(line)) continue;
        lines.push(
          line
            .map((el: any) => {
              if (el?.tag === 'text') return el.text ?? '';
              if (el?.tag === 'a') return el.text ?? el.href ?? '';
              if (el?.tag === 'img') return '[图片]';
              if (el?.tag === 'at') {
                const uid = String(el?.user_id ?? '');
                // 飞书接收事件里 post 的 at.user_id 常是 @_user_1 占位,交给下面的 stripMentions 展开
                if (/^@_user_\d+$/.test(uid)) return uid;
                return `@${el?.user_name ?? (uid || '未知')}${uid ? `(${uid})` : ''}`;
              }
              return '';
            })
            .join(''),
        );
      }
    }
    const title = parsed?.title ?? parsed?.zh_cn?.title ?? parsed?.en_us?.title;
    return stripMentions([title, ...lines].filter(Boolean).join('\n'), message?.mentions);
  }
  if (type === 'image') return '[图片]';
  if (type === 'audio') return '[语音]';
  if (type === 'media') return '[视频]';
  if (type === 'sticker') return '[表情]';
  if (type === 'file') return '[文件] ' + String(parsed?.file_name ?? '');
  return '[未识别的消息:' + type + ']';
}

export class FeishuWorld implements World {
  readonly id = 'feishu';
  private host?: WorldHost;
  private client: any;
  private ws: any;
  private lastError?: string;
  /** 仅记录连接层的致命错误(凭证不对、长连接彻底失败),跟单条消息的临时小错分开。 */
  private connError?: string;
  private connected = false;
  private phase = 'idle';
  private seen = new Set<string>();
  /** 表情回复事件去重(同一个 event_id 只推一次) */
  private seenReactions = new Set<string>();
  private stats = { day: '', replies: 0, received: 0 };
  /** 账本解析失败时为 false:不把今日计数清零,发送也先停,等账本修好或手动归零。 */
  private statsOk = true;
  /** 会话流水:给 WebUI 的「会话」面板看,进出都记。`who` 是这一句的说话人(进来的是发信人名)。 */
  private thread: Array<{ dir: 'in' | 'out'; ts: string; text: string; chatId: string; messageId: string; who?: string; chatType?: string; openId?: string }> = [];
  /** messageId → chatId 的映射:即使面板清空了会话流水或超过 300 条,也能认出已知消息属于哪个会话。 */
  private messageChats = new Map<string, string>();
  /** 见过的会话。没见过的 chatId 不能发。 */
  private chats = new Map<string, { chatType: string; openId: string }>();
  /** open_id → 名字的缓存:查到一次就存下来,重启也还在,省得每条消息都去查通讯录。 */
  private names = new Map<string, string>();
  /** open_id → 部门名(第一个部门)。没权限或查不到就空着。 */
  private depts = new Map<string, string>();
  /** 查过名字但没有结果的时间。过期前不再打通讯录。 */
  private nameMiss = new Map<string, number>();
  /** 查过部门但没结果的时间。过期前不再打通讯录。 */
  private deptMiss = new Map<string, number>();
  /** 正在查询中的 open_id → Promise,防止并发消息同时穿透缓存重复打通讯录。 */
  private nameInFlight = new Map<string, Promise<string>>();
  /** 投递侧顺序锁:解析阶段各条并发,落盘和 pushEvent 按到达顺序提交,既不顶住后消息也不乱序。 */
  private commitTail: Promise<void> = Promise.resolve();
  private starting?: Promise<void>;
  /** stop 会把它加一,进行中的 connect 看到代数变了就不再把套接字挂上。 */
  private generation = 0;
  private enabledSeen = false;
  private syncing = false;

  constructor(private ctx: WorldContext<FeishuConfigSection>) {
    this.enabledSeen = Boolean(this.ctx.cfg.enabled);
    this.loadStats();
    this.loadThread();
    this.loadChats();
    this.hydrateChatsFromThread();
    this.loadNames();
  }

  // ---------- 会话流水(WebUI 面板用) ----------

  private threadFile() {
    return join(this.ctx.dataDir, 'feishu', 'thread.json');
  }

  private chatsFile() {
    return join(this.ctx.dataDir, 'feishu', 'chats.json');
  }

  /** 先写临时文件再替换。Windows 上目标已存在时 rename 会失败,先删掉再换。 */
  private writeJson(file: string, value: unknown) {
    fs.mkdirSync(join(this.ctx.dataDir, 'feishu'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    }
  }

  private loadThread() {
    let text = '';
    try {
      text = fs.readFileSync(this.threadFile(), 'utf8');
    } catch {
      return;
    }
    try {
      const raw = JSON.parse(text);
      if (!Array.isArray(raw?.messages)) throw Error('会话流水不是预期的格式');
      this.thread = raw.messages;
    } catch {
      this.lastError = '会话流水读不了,旧文件留在 thread.json.bad';
      try {
        fs.renameSync(this.threadFile(), this.threadFile() + '.bad');
      } catch {
        // 留在原地也行,下次成功的写入会换掉它
      }
    }
  }

  private loadChats() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.chatsFile(), 'utf8'));
      for (const [id, meta] of Object.entries(raw?.chats ?? {})) {
        if (!id || !meta || typeof meta !== 'object') continue;
        const row = meta as { chatType?: unknown; openId?: unknown };
        this.chats.set(id, { chatType: String(row.chatType ?? ''), openId: String(row.openId ?? '') });
      }
    } catch {
      // 第一次跑,或文件坏了:下面会用流水里的 chatId 补一截
    }
  }

  /** 升级前的流水没有会话类型。先把见过的 chatId 放进来,类型等下一条消息补上。 */
  private hydrateChatsFromThread() {
    for (const m of this.thread) {
      const chatId = String(m?.chatId ?? '');
      const messageId = String(m?.messageId ?? '');
      if (messageId && chatId) this.rememberMessageChat(messageId, chatId);
      if (!chatId) continue;
      const prev = this.chats.get(chatId);
      const chatType = String(m.chatType ?? '') || prev?.chatType || '';
      const who = String(m.who ?? '');
      const openFromWho = /^ou_[0-9a-fA-F]{16,64}$/.test(who) ? who : '';
      const openId = chatType === 'group' ? '' : (prev?.openId || String(m.openId ?? '') || openFromWho);
      if (!prev) this.chats.set(chatId, { chatType, openId });
      else if ((!prev.chatType && chatType) || (!prev.openId && openId)) {
        this.chats.set(chatId, { chatType: prev.chatType || chatType, openId: prev.openId || openId });
      }
    }
  }

  private saveChats() {
    try {
      this.writeJson(this.chatsFile(), { chats: Object.fromEntries(this.chats) });
    } catch {
      // 名单写不进去就下次再记;发送侧会拒绝没见过的会话
    }
  }

  private noteChat(chatId: string, chatType: string, openId: string) {
    if (!chatId) return;
    const prev = this.chats.get(chatId);
    const nextType = chatType || prev?.chatType || '';
    const nextOpen = nextType === 'group' ? '' : (openId || prev?.openId || '');
    if (prev && prev.chatType === nextType && prev.openId === nextOpen) return;
    this.chats.set(chatId, { chatType: nextType, openId: nextOpen });
    this.saveChats();
  }

  private rememberMessageChat(messageId: string, chatId: string) {
    if (!messageId || !chatId) return;
    this.messageChats.set(messageId, chatId);
    if (this.messageChats.size > 2000) {
      const keep = [...this.messageChats.entries()].slice(-1000);
      this.messageChats = new Map(keep);
    }
  }

  private chatOfMessage(messageId: string): string {
    const mapped = this.messageChats.get(messageId);
    if (mapped) return mapped;
    for (let i = this.thread.length - 1; i >= 0; i -= 1) {
      if (this.thread[i]?.messageId === messageId && this.thread[i]?.chatId) return this.thread[i].chatId;
    }
    return '';
  }

  private record(dir: 'in' | 'out', text: string, chatId: string, messageId: string, who = '', chatType = '', openId = '') {
    this.rememberMessageChat(messageId, chatId);
    this.thread.push({
      dir,
      ts: nowIso(this.ctx.timezone),
      text,
      chatId,
      messageId,
      who,
      ...(chatType ? { chatType } : {}),
      ...(openId ? { openId } : {}),
    });
    if (this.thread.length > 300) this.thread = this.thread.slice(-300);
    try {
      this.writeJson(this.threadFile(), { messages: this.thread });
    } catch {
      // 流水写不进去不影响收发
    }
  }

  // ---------- 本地小账本:每天回了几条 ----------

  private statsFile() {
    return join(this.ctx.dataDir, 'feishu', 'state.json');
  }

  private loadStats() {
    let text = '';
    try {
      text = fs.readFileSync(this.statsFile(), 'utf8');
    } catch {
      return;
    }
    try {
      const raw = JSON.parse(text);
      const replies = Number(raw?.replies);
      const received = Number(raw?.received);
      if (!raw || typeof raw !== 'object' || !Number.isFinite(replies) || !Number.isFinite(received)) {
        throw Error('账本不是预期的格式');
      }
      this.stats = { day: String(raw.day ?? ''), replies, received };
      this.statsOk = true;
    } catch {
      this.statsOk = false;
      this.lastError = '账本读不了,今日计数先不动,发送也先停';
    }
  }

  private saveStats(force = false) {
    if (!this.statsOk && !force) return;
    try {
      this.writeJson(this.statsFile(), this.stats);
      this.statsOk = true;
    } catch (e) {
      this.statsOk = false;
      this.lastError = e instanceof Error ? e.message : '账本写不进去';
    }
  }

  private rollDay() {
    if (!this.statsOk) return;
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: this.ctx.timezone || 'Asia/Shanghai' }).format(new Date());
    if (this.stats.day !== today) {
      this.stats = { day: today, replies: 0, received: 0 };
      this.saveStats();
    }
  }

  // ---------- 认人:open_id → 名字 ----------

  private namesFile() {
    return join(this.ctx.dataDir, 'feishu', 'names.json');
  }

  private loadNames() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.namesFile(), 'utf8')) ?? {};
      // 老格式是扁平的 {open_id: 名字};新格式多存一份部门,两种都认。
      const nameMap = raw?.names && typeof raw.names === 'object' ? raw.names : raw;
      for (const [id, name] of Object.entries(nameMap ?? {})) {
        if (typeof name === 'string' && name) this.names.set(id, name);
      }
      for (const [id, dept] of Object.entries(raw?.depts ?? {})) {
        if (typeof dept === 'string' && dept) this.depts.set(id, dept);
      }
      this.readMisses(this.nameMiss, raw?.nameMiss);
      this.readMisses(this.deptMiss, raw?.deptMiss);
    } catch {
      // 第一次跑,还没有名单
    }
  }

  private readMisses(into: Map<string, number>, raw: unknown) {
    if (!raw || typeof raw !== 'object') return;
    for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
      const ts = Number(at);
      if (id && Number.isFinite(ts)) into.set(id, ts);
    }
  }

  private saveNames() {
    try {
      this.writeJson(this.namesFile(), {
        names: Object.fromEntries(this.names),
        depts: Object.fromEntries(this.depts),
        nameMiss: Object.fromEntries(this.nameMiss),
        deptMiss: Object.fromEntries(this.deptMiss),
      });
    } catch {
      // 名单存不下不影响收发,下次再查一遍而已
    }
  }

  private missFresh(map: Map<string, number>, id: string) {
    const at = map.get(id);
    if (!at) return false;
    if (Date.now() - at > MISS_TTL_MS) {
      map.delete(id);
      return false;
    }
    return true;
  }

  /** 负缓存。没连上时不要记,免得把「还没启动」记成「这个人查不到」。 */
  private rememberMiss(map: Map<string, number>, id: string, deferSave = false) {
    if (!id) return;
    map.set(id, Date.now());
    if (!deferSave) this.saveNames();
  }

  /**
   * 拿 open_id 换名字,查到的记进缓存。
   * 要「通讯录读取」权限,而且这个人得在应用的可用范围里,否则只会拿到空字串(不报错)。
   */
  private async resolveName(openId: string, deferSave = false): Promise<string> {
    if (!openId) return '';
    const hit = this.names.get(openId);
    if (hit) {
      // 名字有缓存,部门可能还没有——补查一次,查不到就算了。
      if (!this.depts.has(openId) && !this.missFresh(this.deptMiss, openId)) await this.resolveDept(openId, deferSave);
      return hit;
    }
    if (this.missFresh(this.nameMiss, openId) || !this.client) return '';
    const inflight = this.nameInFlight.get(openId);
    if (inflight) return inflight;
    const task = (async () => {
      try {
        const res: any = await this.client.contact.user.get({
          path: { user_id: openId },
          params: { user_id_type: 'open_id', department_id_type: 'open_department_id' },
        });
        const user = res?.data?.user;
        const name = String(user?.name ?? '');
        if (!name) {
          this.rememberMiss(this.nameMiss, openId, deferSave);
          return '';
        }
        this.names.set(openId, name);
        this.nameMiss.delete(openId);
        const firstDeptId = String(user?.department_ids?.[0] ?? '');
        if (firstDeptId) {
          const dept = await this.deptName(firstDeptId);
          if (dept) {
            this.depts.set(openId, dept);
            this.deptMiss.delete(openId);
          } else {
            this.deptMiss.set(openId, Date.now());
          }
        } else if (user?.job_title) {
          this.depts.set(openId, String(user.job_title));
          this.deptMiss.delete(openId);
        } else {
          this.deptMiss.set(openId, Date.now());
        }
        if (!deferSave) this.saveNames();
        return name;
      } catch {
        // 跨租户、个人版没有组织架构时这里会 41050。记一笔就好,别盖住连接状态。
        this.rememberMiss(this.nameMiss, openId, deferSave);
        return '';
      } finally {
        this.nameInFlight.delete(openId);
      }
    })();
    this.nameInFlight.set(openId, task);
    return task;
  }

  /** 只补部门:通讯录里按 open_id 查一次,把第一个部门的名字记下来。 */
  private async resolveDept(openId: string, deferSave = false): Promise<string> {
    if (!this.client || !openId || this.missFresh(this.deptMiss, openId)) return '';
    try {
      const res: any = await this.client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id', department_id_type: 'open_department_id' },
      });
      const user = res?.data?.user;
      const firstDeptId = String(user?.department_ids?.[0] ?? '');
      const dept = firstDeptId ? await this.deptName(firstDeptId) : String(user?.job_title ?? '');
      if (dept) {
        this.depts.set(openId, dept);
        this.deptMiss.delete(openId);
        if (!deferSave) this.saveNames();
      } else {
        this.rememberMiss(this.deptMiss, openId, deferSave);
      }
      return dept;
    } catch {
      this.rememberMiss(this.deptMiss, openId, deferSave);
      return '';
    }
  }

  /** 部门 id → 部门名。先按 open_department_id 查,不行再用默认参数查一次。 */
  private async deptName(departmentId: string): Promise<string> {
    if (!this.client || !departmentId) return '';
    try {
      const res: any = await this.client.contact.department.get({
        path: { department_id: departmentId },
        params: { user_id_type: 'open_id', department_id_type: 'open_department_id' },
      });
      return String(res?.data?.department?.name ?? '');
    } catch {
      try {
        const res: any = await this.client.contact.department.get({
          path: { department_id: departmentId },
        });
        return String(res?.data?.department?.name ?? '');
      } catch {
        return '';
      }
    }
  }

  /** 谁在跟这个人说话:名字(+部门),查不到名字就把 open_id 原样带上,至少能分清是两个人。 */
  private label(openId: string, name: string) {
    if (!openId) return '';
    if (!name) return openId;
    const dept = this.depts.get(openId) ?? '';
    return `${name}(${openId}${dept ? ` · ${dept}` : ''})`;
  }

  /** 群成员名单:一次拉全(翻页),顺手把名字和部门补进缓存。 */
  private async roster(chatId: string): Promise<ToolOutcome> {
    if (!chatId) throw Error('chatId 不能为空');
    if (!this.client) throw Error('飞书还没连上,先在设置里填好凭证');
    const rawItems: Array<{ openId: string; rawName: string; type: string }> = [];
    let pageToken = '';
    for (let page = 0; page < 20; page += 1) {
      let res: any;
      try {
        res = await this.client.im.chatMembers.get({
          path: { chat_id: chatId },
          params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
        });
      } catch (e) {
        const why = describeErr(e);
        this.lastError = '拉群成员失败:' + why;
        throw Error('拉群成员失败:' + why);
      }
      for (const it of res?.data?.items ?? []) {
        const openId = String(it?.member_id ?? '');
        if (!openId) continue;
        rawItems.push({
          openId,
          rawName: String(it?.name ?? ''),
          type: String(it?.member_id_type ?? ''),
        });
      }
      pageToken = String(res?.data?.page_token ?? '');
      if (!res?.data?.has_more || !pageToken) break;
    }
    const lookupDept = rawItems.length <= ROSTER_DEPT_LOOKUP_MAX;
    const members: Array<{ openId: string; name: string; dept: string; type: string }> = [];
    for (const it of rawItems) {
      const { openId, rawName, type } = it;
      const cached = this.names.get(openId) ?? '';
      const name = rawName || cached || (await this.resolveName(openId, true));
      if (name) {
        this.names.set(openId, name);
        this.nameMiss.delete(openId);
      }
      const dept = this.depts.get(openId) || (lookupDept && openId ? await this.resolveDept(openId, true) : '');
      members.push({ openId, name, dept, type });
    }
    this.saveNames();
    let title = '';
    try {
      const info: any = await this.client.im.chat.get({
        path: { chat_id: chatId },
        params: { user_id_type: 'open_id' },
      });
      title = String(info?.data?.name ?? '');
    } catch {
      // 群名拿不到无所谓,成员名单才是重点
    }
    return { text: JSON.stringify({ chatId, title, count: members.length, members }) };
  }

  // ---------- 生命周期 ----------

  /**
   * 配置页改的是宿主的 enabled。保存配置时会再问一次 webUi,
   * 这里发现开关变了就让宿主按新值挂上或卸下。不在收消息的回调里调,免得和断线缠在一起。
   */
  private followEnabled() {
    const want = Boolean(this.ctx.cfg.enabled);
    if (want === this.enabledSeen || this.syncing) return;
    const prev = this.enabledSeen;
    this.enabledSeen = want;
    this.syncing = true;
    void this.ctx.restart().then(() => undefined, () => {
      this.enabledSeen = prev;
    }).finally(() => {
      this.syncing = false;
    });
  }

  async start(host: WorldHost) {
    this.host = host;
    this.enabledSeen = Boolean(this.ctx.cfg.enabled);
    if (!this.ctx.cfg.enabled) return;
    await this.connect();
  }

  async stop() {
    this.generation += 1;
    const pending = this.starting;
    try {
      await pending;
    } catch {
      // 正在起的那次失败了也要继续拆
    }
    await this.stopConnection();
    this.client = undefined;
    this.connected = false;
    this.host = undefined;
  }

  onRunPhase(phase: RunPhase) {
    this.phase = phase.state;
    this.followEnabled();
  }

  private async connect(opts: { waitReady?: boolean } = {}) {
    if (this.starting && !opts.waitReady) return this.starting;
    const gen = ++this.generation;
    const run = (async () => {
      await this.stopConnection();
      if (gen !== this.generation) return;
      if (this.statsOk) this.lastError = undefined;
      const appId = this.ctx.secret(FEISHU_SECRET_APP_ID);
      const appSecret = this.ctx.secret(FEISHU_SECRET_APP_SECRET);
      if (!appId || !appSecret) {
        this.connError = '还没填 App ID / App Secret,用 feishu_setup 存一次就好';
        this.lastError = this.connError;
        this.connected = false;
        return;
      }
      if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
        this.connError = `App ID 格式不对(${appId}),应为 cli_ 加 16 位十六进制字符`;
        this.lastError = this.connError;
        this.connected = false;
        return;
      }
      let settleReady!: () => void;
      const readyPromise = new Promise<void>((resolve) => {
        let settled = false;
        settleReady = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
      });
      try {
        this.client = new lark.Client({ appId, appSecret, loggerLevel: lark.LoggerLevel.info });
        const dispatcher = new lark.EventDispatcher({}).register({
          'im.message.receive_v1': (data: any) => {
            void this.onMessage(data).catch((e) => {
              this.lastError = '收消息失败:' + describeErr(e);
            });
          },
          'im.message.reaction.created_v1': (data: any) => {
            void this.onReaction(data).catch((e) => {
              this.lastError = '收表情回复失败:' + describeErr(e);
            });
          },
        });
        if (gen !== this.generation) {
          settleReady();
          return;
        }
        this.ws = new lark.WSClient({
          appId,
          appSecret,
          loggerLevel: lark.LoggerLevel.info,
          onReady: () => {
            if (gen !== this.generation) {
              settleReady();
              return;
            }
            this.connected = true;
            this.connError = undefined;
            if (this.statsOk) this.lastError = undefined;
            settleReady();
          },
          onError: (e: unknown) => {
            if (gen !== this.generation) {
              settleReady();
              return;
            }
            this.connError = e instanceof Error ? e.message : String(e);
            this.lastError = this.connError;
            this.connected = false;
            settleReady();
          },
          onReconnecting: () => {
            if (gen !== this.generation) return;
            this.connected = false;
          },
          onReconnected: () => {
            if (gen !== this.generation) return;
            this.connected = true;
            this.connError = undefined;
            if (this.statsOk) this.lastError = undefined;
          },
        });
        const pendingStart = this.ws.start({
          eventDispatcher: dispatcher,
        });
        if (gen !== this.generation) {
          try {
            this.ws?.close?.({ force: true });
          } catch {
            // 这次连接已经作废
          }
          this.ws = undefined;
          this.client = undefined;
          this.connected = false;
          settleReady();
          return;
        }
        void Promise.resolve(pendingStart).catch((e: unknown) => {
          if (gen !== this.generation) {
            settleReady();
            return;
          }
          this.connError = e instanceof Error ? e.message : String(e);
          this.lastError = this.connError;
          this.connected = false;
          settleReady();
        });
        if (opts.waitReady) {
          let waitTimer: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<void>((resolve) => {
            waitTimer = setTimeout(resolve, CONNECT_WAIT_READY_MS);
          });
          await Promise.race([readyPromise, timeoutPromise]);
          if (waitTimer) clearTimeout(waitTimer);
        }
      } catch (e) {
        if (gen !== this.generation) {
          settleReady();
          return;
        }
        this.connError = e instanceof Error ? e.message : '长连接起不来';
        this.lastError = this.connError;
        this.connected = false;
        settleReady();
      }
    })();
    this.starting = run;
    void run.finally(() => {
      if (this.starting === run) this.starting = undefined;
    });
    return run;
  }

  private async stopConnection() {
    try {
      this.ws?.close?.({ force: true });
    } catch {
      // 旧连接本来就没起
    }
    this.ws = undefined;
    this.connected = false;
    this.connError = undefined;
  }

  // ---------- 收消息 ----------

  /** 按调用者在同步段拿到的顺序槽位执行提交动作,前一条落地(或超时)后放行下一条。 */
  private reserveCommit(): (fn: () => Promise<void> | void) => Promise<void> {
    const prev = this.commitTail;
    let release!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.commitTail = new Promise<void>((resolve) => {
      release = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        resolve();
      };
    });
    return async (fn) => {
      try {
        await prev;
        // 轮到这条了才开始计时:兜的是下面 fn() 卡住,不是前面解析慢
        timer = setTimeout(() => {
          this.lastError = '提交槽位超时,先放行后面的消息';
          release();
        }, COMMIT_SLOT_TIMEOUT_MS);
        await fn();
      } finally {
        release();
      }
    };
  }

  private async onMessage(data: any) {
    const message = data?.message;
    if (!message?.message_id) return;
    if (!this.ctx.cfg.enabled) return;
    this.connected = true;
    this.connError = undefined;
    const cfg = this.ctx.cfg;
    const chatType = String(message.chat_type ?? '');
    if (chatType === 'group' && !cfg.replyToGroup) return;
    if (this.seen.has(message.message_id)) return;
    this.seen.add(message.message_id);
    if (this.seen.size > 800) this.seen = new Set([...this.seen].slice(-400));

    const sender = data?.sender;
    if (String(sender?.sender_type ?? '') === 'app') return; // 机器人自己发的,不理,免得自问自答
    const openId = String(sender?.sender_id?.open_id ?? '');
    const chatId = String(message.chat_id ?? '');
    this.noteChat(chatId, chatType, openId);
    const owner = String(cfg.ownerOpenId ?? '').trim();
    // 只限制私聊。群里其他人的话照样推进来,靠 from 区分是谁。
    if (chatType !== 'group' && owner && openId && openId !== owner) {
      const skipped = messageText(message);
      this.rollDay();
      this.stats.received += 1;
      this.saveStats();
      this.record('in', skipped || '[私聊已忽略]', chatId, String(message.message_id), this.names.get(openId) || openId, chatType, openId);
      return;
    }

    // 在第一个 await 之前占好提交槽位,保证上游看到的顺序严格等于消息到达顺序
    const commit = this.reserveCommit();
    try {
      // @ 的人:飞书有时只给占位不给名字,补查一下,群里才认得出叫的是谁。
      if (Array.isArray(message?.mentions)) {
        for (const m of message.mentions) {
          const id = String(m?.id?.open_id ?? '');
          if (!m?.name && id) {
            const name = await this.resolveName(id);
            if (name) m.name = name;
          }
        }
      }
      const text = messageText(message);
      if (!text) {
        await commit(() => {});
        return;
      }
      const senderName = await this.resolveName(openId);

      // 图片:并发启动下载,先等一小段(IMAGE_INLINE_WAIT_MS);
      // 赶上的直接随原消息附上,超时的先放行文字,等下完再补一条带图事件,免得慢图顶住后面的消息。
      let blobs: Array<{ bytes: Buffer; mime: string; name: string; fallbackText: string }> | undefined;
      let localError = false;
      const lateImages: Array<{ index: number; promise: Promise<{ bytes: Buffer; mime: string } | null> }> = [];
      const keys = imageKeys(message);
      if (keys.length) {
        const downloads = keys.slice(0, 3).map((key, index) => ({
          index,
          promise: this.fetchImage(message, key),
        }));
        const inlineTimeout = Symbol('inline-wait-timeout');
        let waitTimer: ReturnType<typeof setTimeout> | undefined;
        const waitLimit = new Promise<typeof inlineTimeout>((resolve) => {
          waitTimer = setTimeout(() => resolve(inlineTimeout), IMAGE_INLINE_WAIT_MS);
        });
        const raced = await Promise.all(
          downloads.map(({ promise }) => Promise.race([promise, waitLimit])),
        );
        if (waitTimer) clearTimeout(waitTimer);
        const got: Array<{ bytes: Buffer; mime: string; name: string; fallbackText: string }> = [];
        for (let i = 0; i < raced.length; i += 1) {
          const res = raced[i];
          if (res === inlineTimeout) {
            lateImages.push(downloads[i]);
          } else if (res) {
            got.push({
              bytes: res.bytes,
              mime: res.mime,
              name: `${message.message_id}-${downloads[i].index + 1}`,
              fallbackText: '飞书图片',
            });
          } else {
            localError = true;
          }
        }
        if (got.length) blobs = got;
      }

      const who = chatType === 'group' ? '飞书群' : '飞书私聊';
      await commit(async () => {
        this.rollDay();
        this.stats.received += 1;
        this.saveStats();
        this.record('in', text, chatId, String(message.message_id), senderName || openId, chatType, openId);

        try {
          await this.host?.pushEvent({
            type: 'feishu.message',
            source: this.id,
            ts: nowIso(this.ctx.timezone),
            origin: 'external',
            senderKey: 'feishu.' + (openId || String(message.chat_id ?? '')),
            text:
              `[${who}] ` +
              text +
              `\n(chatId: ${message.chat_id} · messageId: ${message.message_id}` +
              (openId ? ` · from: ${this.label(openId, senderName)}` : '') +
              `)`,
            meta: {
              chatId: String(message.chat_id ?? ''),
              messageId: String(message.message_id),
              openId,
              senderName,
              senderDept: this.depts.get(openId) ?? '',
              chatType,
            },
            ...(blobs ? { blobs } : {}),
          });
          if (this.statsOk && !this.connError && !localError) this.lastError = undefined;
        } catch (e) {
          this.lastError = e instanceof Error ? e.message : '推不上来';
        }
      });

      // 慢图下完后补推附件事件,不阻塞后续消息
      for (const late of lateImages) {
        void late.promise.then((img) => {
          if (!img) return;
          return this.host?.pushEvent({
            type: 'feishu.message',
            source: this.id,
            ts: nowIso(this.ctx.timezone),
            origin: 'external',
            senderKey: 'feishu.' + (openId || String(message.chat_id ?? '')),
            text:
              `[${who}] [图片附件，来自消息 ${message.message_id}]` +
              `\n(chatId: ${message.chat_id} · messageId: ${message.message_id}` +
              (openId ? ` · from: ${this.label(openId, senderName)}` : '') +
              `)`,
            meta: {
              chatId: String(message.chat_id ?? ''),
              messageId: String(message.message_id),
              openId,
              senderName,
              senderDept: this.depts.get(openId) ?? '',
              chatType,
            },
            blobs: [{
              bytes: img.bytes,
              mime: img.mime,
              name: `${message.message_id}-${late.index + 1}`,
              fallbackText: '飞书图片',
            }],
          });
        }).catch(() => {});
      }
    } catch (e) {
      await commit(() => {});
      this.seen.delete(message.message_id);
      throw e;
    }
  }

  // ---------- 收表情回复 ----------

  /**
   * 有人给消息点了表情(im.message.reaction.created_v1)。
   * 事件里不带 chatId,只能靠本地记过的 messageId→chatId 反查;
   * 没见过那条消息就不推——不知道在哪个会话里,推上来也没法回。
   */
  private async onReaction(data: any) {
    if (!this.ctx.cfg.enabled) return;
    const messageId = String(data?.message_id ?? '');
    const emoji = String(data?.reaction_type?.emoji_type ?? '');
    if (!messageId || !emoji) return;
    this.connected = true;
    this.connError = undefined;
    // operator_type 是 app 的是机器人自己点的,不理
    if (String(data?.operator_type ?? '') === 'app') return;
    const openId = String(data?.user_id?.open_id ?? '');
    const eventId =
      String(data?.event_id ?? '') ||
      `${messageId}:${openId}:${emoji}:${String(data?.action_time ?? '')}`;
    if (this.seenReactions.has(eventId)) return;
    this.seenReactions.add(eventId);
    if (this.seenReactions.size > 800) this.seenReactions = new Set([...this.seenReactions].slice(-400));

    const chatId = this.chatOfMessage(messageId);
    if (!chatId) return;
    const cfg = this.ctx.cfg;
    const chatInfo = this.chats.get(chatId);
    const chatType = chatInfo?.chatType || 'p2p';
    if (chatType === 'group' && !cfg.replyToGroup) return;

    const face = REACTION_FACES[emoji] ? `${REACTION_FACES[emoji]}(${emoji})` : emoji;
    const owner = String(cfg.ownerOpenId ?? '').trim();
    const peerOpenId = openId || chatInfo?.openId || '';
    if (chatType !== 'group' && owner && peerOpenId !== owner) {
      this.rollDay();
      this.stats.received += 1;
      this.saveStats();
      this.record('in', `[表情回复] ${face} 给消息 ${messageId}`, chatId, '', this.names.get(openId) || openId, chatType, openId);
      return;
    }

    const commit = this.reserveCommit();
    try {
      const senderName = await this.resolveName(openId);
      const mine = this.thread.some((t) => t.messageId === messageId && t.dir === 'out');
      const who = chatType === 'group' ? '飞书群' : '飞书私聊';
      await commit(async () => {
        this.rollDay();
        this.stats.received += 1;
        this.saveStats();
        this.record('in', `[表情回复] ${face} 给消息 ${messageId}`, chatId, '', senderName || openId, chatType, openId);
        try {
          await this.host?.pushEvent({
            type: 'feishu.message',
            source: this.id,
            ts: nowIso(this.ctx.timezone),
            origin: 'external',
            senderKey: 'feishu.' + (openId || chatId),
            text:
              `[${who}] [表情回复] 给消息 ${messageId} 加了表情 ${face}` +
              `\n(chatId: ${chatId} · messageId: ${messageId}` +
              (openId ? ` · from: ${this.label(openId, senderName)}` : '') +
              (mine ? ' · 这条是你发的' : '') +
              ')',
            meta: {
              chatId,
              messageId,
              openId,
              senderName,
              senderDept: this.depts.get(openId) ?? '',
              chatType,
              reaction: emoji,
            },
          });
          if (this.statsOk && !this.connError) this.lastError = undefined;
        } catch (e) {
          this.lastError = e instanceof Error ? e.message : '推不上来';
        }
      });
    } catch (e) {
      await commit(() => {});
      this.seenReactions.delete(eventId);
      throw e;
    }
  }

  // ---------- 收图 ----------

  /**
   * 把消息里的图片抓成字节,给事件当 blob 附件。
   * 失败就当没这张图,聊天照常继续——不能因为一张图把整条消息吞掉。
   */
  private async fetchImage(message: any, explicitKey?: string): Promise<{ bytes: Buffer; mime: string } | null> {
    let stream: any;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      let parsed: any = undefined;
      try {
        parsed = typeof message?.content === 'string' ? JSON.parse(message.content) : undefined;
      } catch {
        parsed = undefined;
      }
      // 普通图片给 image_key;富文本里的图由调用方直接传 key。表情包不走这里。
      const key = String(explicitKey ?? parsed?.image_key ?? parsed?.file_key ?? '');
      if (!key) return null;
      const download = (async () => {
        const res = await this.client.im.messageResource.get({
          path: { message_id: String(message.message_id ?? ''), file_key: key },
          params: { type: 'image' },
        });
        stream = res.getReadableStream();
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        if (!bytes.length) return null;
        const raw = String(res.headers?.['content-type'] ?? 'image/jpeg').split(';')[0].trim();
        return { bytes, mime: raw || 'image/jpeg' };
      })();
      void download.catch(() => null);
      const timeout = new Promise<null>((_, reject) => {
        timer = setTimeout(() => reject(new Error('下载超时')), IMAGE_FETCH_TIMEOUT_MS);
      });
      return await Promise.race([download, timeout]);
    } catch (e) {
      this.lastError = '收图失败:' + describeErr(e);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      try {
        stream?.destroy?.();
      } catch {
        // 已经读完或已经销毁
      }
    }
  }

  // ---------- 发消息 ----------

  /** 只发给本进程见过的会话。群和还不知道类型的会话里,正文不能带内部编号。 */
  private assertChat(chatId: string, text: string) {
    const known = this.chats.get(chatId);
    if (!known) throw Error('没见过这个会话,不能发');
    if (known.chatType === 'group' && !this.ctx.cfg.replyToGroup) throw Error('群发关着,这条不发');
    const owner = String(this.ctx.cfg.ownerOpenId ?? '').trim();
    if (owner && known.chatType !== 'group') {
      if (known.chatType !== 'p2p' || !known.openId) {
        throw Error('这个会话认不出是谁,先让对方发一句再回');
      }
      if (known.openId !== owner) {
        throw Error('这个私聊不是主人的,不发');
      }
    }
    const leaksId = /(?:ou|oc)_[0-9a-fA-F]{16,64}/.test(text);
    if (leaksId && known.chatType !== 'p2p') throw Error('这条会把 open_id 或 chatId 发出去,先改掉再发');
  }

  private async send(args: Record<string, unknown>): Promise<ToolOutcome> {
    if (!this.client) throw Error('飞书还没连上,先在设置里填好凭证');
    if (!this.statsOk) throw Error(this.lastError || '账本读不了,先不发');
    this.rollDay();
    const limit = this.ctx.cfg.maxDailyReplies || 0;
    if (limit > 0 && this.stats.replies >= limit) throw Error(`今天已经回了 ${this.stats.replies} 条,到上限了`);

    const text = String(args.text ?? '');
    if (!text.trim()) throw Error('要说的话不能是空的');
    const messageId = typeof args.messageId === 'string' ? args.messageId.trim() : '';
    const requestedChat = typeof args.chatId === 'string' ? args.chatId.trim() : '';
    let chatId = requestedChat;
    if (messageId) {
      const known = this.chatOfMessage(messageId);
      if (!known) throw Error('没见过这条消息,不能回复');
      if (requestedChat && requestedChat !== known) {
        throw Error('messageId 所在的会话和传入的 chatId 不一致,请核对后再发');
      }
      chatId = known;
    } else if (!chatId) {
      throw Error('要么给 messageId,要么给 chatId');
    }
    this.assertChat(chatId, text);
    const content = JSON.stringify({ text: text.slice(0, 3000) });

    let res: any;
    try {
      if (messageId) {
        res = await this.client.im.message.reply({
          path: { message_id: messageId },
          data: { msg_type: 'text', content },
        });
      } else {
        res = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'text', content },
        });
      }
    } catch (e) {
      const why = describeErr(e);
      this.lastError = '发送失败:' + why;
      return { text: JSON.stringify({ status: 'failed', error: why, note: '没发出去;先看是不是权限或 chatId 不对' }), failed: true };
    }

    const code = res?.code ?? res?.data?.code ?? 0;
    if (code !== 0) {
      this.lastError = `发送失败 ${code}:${res?.msg ?? ''}`;
      return { text: JSON.stringify({ status: 'failed', code, msg: res?.msg ?? '', note: '没发出去;先看是不是权限或 chatId 不对' }), failed: true };
    }
    this.stats.replies += 1;
    this.saveStats();
    if (this.statsOk && !this.connError) this.lastError = undefined;
    const outId = String(res?.data?.message_id ?? '');
    const meta = this.chats.get(chatId);
    this.record('out', text, chatId, outId, '', meta?.chatType ?? '', meta?.openId ?? '');
    return {
      text: JSON.stringify({
        status: 'sent',
        messageId: outId,
        today: this.stats.replies,
      }),
    };
  }

  // ---------- WebUI:会话与凭证面板的数据面 ----------

  /** 页面看得到的凭证状态:App ID 明文(cli_ 后面那截不算秘密),Secret 只报「设没设」。 */
  private setupState() {
    const appId = this.ctx.secret(FEISHU_SECRET_APP_ID);
    return {
      appId: appId || '',
      appIdSet: Boolean(appId),
      secretSet: Boolean(this.ctx.secret(FEISHU_SECRET_APP_SECRET)),
      connected: this.connected,
      enabled: Boolean(this.ctx.cfg.enabled),
      lastError: this.lastError ?? '',
    };
  }

  /**
   * 面板或工具保存凭证。两个字段都允许空:空 = 不改那一项(Secret 尤其要能单独留空,
   * 让人只改 App ID 时不用把 Secret 再贴一遍)。
   */
  private async saveSecrets(args: unknown[]) {
    const appId = String(args[0] ?? '').trim();
    const appSecret = String(args[1] ?? '').trim();
    if (appId) {
      if (/\s/.test(appId)) throw Error('App ID 不能含空白');
      if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) throw Error('App ID 格式不对,应为 cli_ 加 16 位十六进制字符');
    }
    if (appSecret && /\s/.test(appSecret)) throw Error('App Secret 不能含空白');
    if (!appId && !appSecret) throw Error('App ID 和 App Secret 至少填一项');
    if (appId) this.ctx.storeSecret(FEISHU_SECRET_APP_ID, appId);
    if (appSecret) this.ctx.storeSecret(FEISHU_SECRET_APP_SECRET, appSecret);
    if (!this.ctx.cfg.enabled || !this.host) {
      return { ...this.setupState(), stored: true, note: '存好了,启用飞书后才会连' };
    }
    await this.connect({ waitReady: true });
    return {
      ...this.setupState(),
      stored: true,
      note: this.connected ? '存好了,已连上' : '存好了,但没连上,看下面的错误',
    };
  }

  async invokePanel(panel: string, method: string, args: unknown[] = []): Promise<unknown> {
    this.followEnabled();
    if (panel === 'chat' && method === 'list') {
      this.rollDay(); // 过了零点再打开面板时,别还显示昨天的数
      return {
        messages: this.thread,
        connected: this.connected,
        today: this.stats,
        lastError: this.lastError ?? '',
        ownerName: String(this.ctx.cfg.ownerName ?? '').trim(),
      };
    }
    if (panel === 'setup') {
      if (method === 'state') return this.setupState();
      if (method === 'save') return await this.saveSecrets(args);
      throw Error(`未知的面板方法:${panel}.${method}`);
    }
    throw Error(`未知的面板方法:${panel}.${method}`);
  }

  // ---------- 工具 ----------

  tools(): ToolDef[] {
    return FEISHU_TOOL_DECLS.map((decl) => ({
      ...decl,
      handler: async (args): Promise<ToolOutcome> => {
        try {
          this.followEnabled();
          if (decl.name === 'feishu_status') {
            this.rollDay();
            return {
              text: JSON.stringify({
                connected: this.connected,
                configured: Boolean(this.ctx.secret(FEISHU_SECRET_APP_ID)),
                enabled: this.ctx.cfg.enabled,
                today: { received: this.stats.received, replies: this.stats.replies },
                phase: this.phase,
                lastError: this.lastError,
              }),
            };
          }
          if (decl.name === 'feishu_reply') return await this.send(args);
          if (decl.name === 'feishu_roster') return await this.roster(String(args.chatId ?? '').trim());
          if (decl.name === 'feishu_setup') {
            const appId = String(args.appId ?? '').trim();
            const appSecret = String(args.appSecret ?? '').trim();
            if (!appId || !appSecret) throw Error('App ID 和 App Secret 都要填');
            const state = await this.saveSecrets([appId, appSecret]);
            return {
              text: JSON.stringify(state),
            };
          }
          throw Error('未知工具');
        } catch (e) {
          return { text: describeErr(e) || '出错了', failed: true };
        }
      },
    }));
  }

  webUi(): WorldWebUiDecl {
    this.followEnabled();
    const hasSecret = Boolean(this.ctx.secret(FEISHU_SECRET_APP_ID) && this.ctx.secret(FEISHU_SECRET_APP_SECRET));
    const lampState = this.connected
      ? 'online'
      : !this.ctx.cfg.enabled || !hasSecret
        ? 'offline'
        : this.connError
          ? 'error'
          : 'loading';
    const lampHint = this.connError
      || (this.lastError ? `最近一次错误:${this.lastError}` : undefined);
    return {
      label: '飞书',
      lamps: [
        {
          label: '连接',
          state: lampState,
          hint: lampHint,
        },
      ],
      badges: [
        { label: '今日收', value: this.stats.received, tone: 'plain' },
        { label: '今日回', value: this.stats.replies, tone: 'plain' },
      ],
      panels: [
        { id: 'chat', title: '会话', description: '飞书收发的消息,一个窗口里看全。' },
        { id: 'setup', title: '凭证', description: '填飞书应用的 App ID / App Secret;存在本机 .env,页面不回显。' },
      ],
      // 数据页签:流水和计数都能一键清。清完不影响已经收到/发出的消息本身。
      storage: [
        {
          key: 'feishu-thread',
          label: '会话流水',
          kind: 'disk',
          location: this.threadFile(),
          danger: true,
          note: '清掉后「会话」面板就空了。',
          stat: () => `${this.thread.length} 条`,
          clear: () => {
            this.thread = [];
            try {
              fs.rmSync(this.threadFile(), { force: true });
            } catch {
              // 文件本来就不在也算干净
            }
            return '会话流水已清空';
          },
        },
        {
          key: 'feishu-today',
          label: '今日收发计数',
          kind: 'disk',
          location: this.statsFile(),
          danger: true,
          note: '清掉会把今天已回条数归零,每日上限跟着重算。',
          stat: () => `今日收 ${this.stats.received} · 回 ${this.stats.replies}`,
          clear: () => {
            this.stats = { day: '', replies: 0, received: 0 };
            this.statsOk = true;
            this.saveStats(true);
            return '今日计数已归零';
          },
        },
        {
          key: 'feishu-names',
          label: '认人缓存',
          kind: 'disk',
          location: this.namesFile(),
          note: 'open_id 换成名字和部门的缓存,清了下次会重新查通讯录。',
          stat: () => `${this.names.size} 人`,
          clear: () => {
            this.names.clear();
            this.depts.clear();
            this.nameMiss.clear();
            this.deptMiss.clear();
            try {
              fs.rmSync(this.namesFile(), { force: true });
            } catch {
              // 文件本来就不在也算干净
            }
            return '认人缓存已清空';
          },
        },
      ],
      // 配置页签:声明了才会在页面上露出 worlds.feishu.* 那几项(含群聊开关)。
      config: [FEISHU_CONFIG_GROUP],
      invoke: async (panel, method, args) => this.invokePanel(panel, method, args),
      promptDocs: [
        {
          key: 'worlds.feishu.envPrompt',
          title: '飞书 · 环境说明',
          description: '飞书消息怎么回、同意窗怎么提前打招呼。',
          path: ENV,
          role: 'envPrompt',
          vars: [
            { name: 'feishu.state', description: '长连接、开关和今日收发。' },
            { name: 'feishu.ownerName', description: '怎么称呼对方(配置项,留空是「对方」)。' },
            { name: 'feishu.extra', description: '本机专属的补充说明(配置项,可为空)。' },
          ],
        },
      ],
    };
  }

  envPromptVars() {
    this.followEnabled();
    this.rollDay();
    const name = String(this.ctx.cfg.ownerName ?? '').trim();
    const extra = String(this.ctx.cfg.extraPrompt ?? '').trim();
    return {
      'feishu.state': JSON.stringify({
        connected: this.connected,
        enabled: this.ctx.cfg.enabled,
        ownerOnly: Boolean(this.ctx.cfg.ownerOpenId),
        group: this.ctx.cfg.replyToGroup,
        today: this.stats,
      }),
      // 没填称呼就退回「对方」,模板里两条路都说得通。
      'feishu.ownerName': name ? `「${name}」` : '对方',
      'feishu.extra': extra,
    };
  }
}

export { FEISHU_DEFAULTS };
