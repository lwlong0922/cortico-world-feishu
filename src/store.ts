/**
 * 本地持久化存储(<dataDir>/feishu/):
 * - thread.json:最近 300 条收发流水
 * - chats.json:见过的会话(chatId → { chatType, openId })
 * - state.json:每日收发计数与防刷屏账本
 * 同时维护进程内 messageId → chatId 映射与本机器人发出的消息 ID 集合。
 */

import * as fs from 'node:fs';
import { join } from 'node:path';
import { nowIso } from 'cortico/core/util.ts';
import type { FeishuConfigSection } from './config.ts';

export interface ThreadMessage {
  dir: 'in' | 'out';
  ts: string;
  text: string;
  chatId: string;
  messageId: string;
  who?: string;
  chatType?: string;
  openId?: string;
}

export interface ChatMeta {
  chatType: string;
  openId: string;
}

export interface DailyStats {
  day: string;
  replies: number;
  received: number;
}

/** 先写临时文件再替换。Windows 上目标已存在时 rename 会失败,先删掉再换。 */
export function writeJsonAtomic(dir: string, file: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
}

export class FeishuStore {
  readonly baseDir: string;
  /** 会话流水:给 WebUI 的「会话」面板看,进出都记。 */
  thread: ThreadMessage[] = [];
  /** messageId → chatId 的映射:即使面板清空了会话流水或超过 300 条,也能认出已知消息属于哪个会话。 */
  private messageChats = new Map<string, string>();
  /** 本机器人发出过的 messageId:用于识别群里「回复我」或「给我的消息点表情」。 */
  private ownMessages = new Set<string>();
  /** 见过的会话。没见过的 chatId 不能发。 */
  chats = new Map<string, ChatMeta>();
  stats: DailyStats = { day: '', replies: 0, received: 0 };
  /** 账本解析失败时为 false:不把今日计数清零,发送也先停,等账本修好或手动归零。 */
  statsOk = true;

  constructor(
    dataDir: string,
    private timezone: string,
    private onError: (msg: string) => void,
  ) {
    this.baseDir = join(dataDir, 'feishu');
    this.loadStats();
    this.loadThread();
    this.loadChats();
    this.hydrateChatsFromThread();
  }

  threadFile(): string {
    return join(this.baseDir, 'thread.json');
  }

  chatsFile(): string {
    return join(this.baseDir, 'chats.json');
  }

  statsFile(): string {
    return join(this.baseDir, 'state.json');
  }

  private writeJson(file: string, value: unknown): void {
    writeJsonAtomic(this.baseDir, file, value);
  }

  private loadThread(): void {
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
      this.onError('会话流水读不了,旧文件留在 thread.json.bad');
      try {
        fs.renameSync(this.threadFile(), this.threadFile() + '.bad');
      } catch {
        // 留在原地也行,下次成功的写入会换掉它
      }
    }
  }

  private loadChats(): void {
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
  private hydrateChatsFromThread(): void {
    for (const m of this.thread) {
      const chatId = String(m?.chatId ?? '');
      const messageId = String(m?.messageId ?? '');
      if (messageId && chatId) this.rememberMessageChat(messageId, chatId);
      if (messageId && m?.dir === 'out') this.rememberOwnMessage(messageId);
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

  private saveChats(): void {
    try {
      this.writeJson(this.chatsFile(), { chats: Object.fromEntries(this.chats) });
    } catch {
      // 名单写不进去就下次再记;发送侧会拒绝没见过的会话
    }
  }

  noteChat(chatId: string, chatType: string, openId: string): void {
    if (!chatId) return;
    const prev = this.chats.get(chatId);
    const nextType = chatType || prev?.chatType || '';
    const nextOpen = nextType === 'group' ? '' : (openId || prev?.openId || '');
    if (prev && prev.chatType === nextType && prev.openId === nextOpen) return;
    this.chats.set(chatId, { chatType: nextType, openId: nextOpen });
    this.saveChats();
  }

  rememberMessageChat(messageId: string, chatId: string): void {
    if (!messageId || !chatId) return;
    this.messageChats.set(messageId, chatId);
    if (this.messageChats.size > 2000) {
      const keep = [...this.messageChats.entries()].slice(-1000);
      this.messageChats = new Map(keep);
    }
  }

  rememberOwnMessage(messageId: string): void {
    if (!messageId) return;
    this.ownMessages.add(messageId);
    if (this.ownMessages.size > 2000) {
      this.ownMessages = new Set([...this.ownMessages].slice(-1000));
    }
  }

  isOwnMessage(messageId: string): boolean {
    if (!messageId) return false;
    return this.ownMessages.has(messageId) || this.thread.some((t) => t.messageId === messageId && t.dir === 'out');
  }

  chatOfMessage(messageId: string): string {
    const mapped = this.messageChats.get(messageId);
    if (mapped) return mapped;
    for (let i = this.thread.length - 1; i >= 0; i -= 1) {
      if (this.thread[i]?.messageId === messageId && this.thread[i]?.chatId) return this.thread[i].chatId;
    }
    return '';
  }

  record(dir: 'in' | 'out', text: string, chatId: string, messageId: string, who = '', chatType = '', openId = ''): void {
    this.rememberMessageChat(messageId, chatId);
    if (dir === 'out' && messageId) this.rememberOwnMessage(messageId);
    this.thread.push({
      dir,
      ts: nowIso(this.timezone),
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

  clearThread(): string {
    this.thread = [];
    try {
      fs.rmSync(this.threadFile(), { force: true });
    } catch {
      // 文件本来就不在也算干净
    }
    return '会话流水已清空';
  }

  // ---------- 本地小账本:每天回了几条 ----------

  private loadStats(): void {
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
      this.onError('账本读不了,今日计数先不动,发送也先停');
    }
  }

  saveStats(force = false): void {
    if (!this.statsOk && !force) return;
    try {
      this.writeJson(this.statsFile(), this.stats);
      this.statsOk = true;
    } catch (e) {
      this.statsOk = false;
      this.onError(e instanceof Error ? e.message : '账本写不进去');
    }
  }

  rollDay(): void {
    if (!this.statsOk) return;
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: this.timezone || 'Asia/Shanghai' }).format(new Date());
    if (this.stats.day !== today) {
      this.stats = { day: today, replies: 0, received: 0 };
      this.saveStats();
    }
  }

  clearStats(): string {
    this.stats = { day: '', replies: 0, received: 0 };
    this.statsOk = true;
    this.saveStats(true);
    return '今日计数已归零';
  }

  /** 只发给本进程见过的会话。群和还不知道类型的会话里,正文不能带内部编号。 */
  assertChat(chatId: string, text: string, cfg: FeishuConfigSection): void {
    const known = this.chats.get(chatId);
    if (!known) throw Error('没见过这个会话,不能发');
    if (known.chatType === 'group' && !cfg.replyToGroup) throw Error('群发关着,这条不发');
    const owner = String(cfg.ownerOpenId ?? '').trim();
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
}
