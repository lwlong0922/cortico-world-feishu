// 飞书 World:用自建应用 + 长连接,把主人发来的消息推进 Persona 的上下文,
// 再通过 feishu_reply 把话发回飞书。同一个 Persona,不是第二个大脑。
//
// 注意:凭证只存在宿主的秘密配置里,任何工具回执都不回显 App Secret。

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
import { FeishuContacts } from './contacts.ts';
import {
  REACTION_FACES,
  describeErr,
  imageKeys,
  messageText,
  normalizeReactionType,
} from './normalize.ts';
import { FeishuStore } from './store.ts';
import { FEISHU_TOOL_DECLS } from './tools.ts';

/**
 * 环境模板:role=envPrompt 的那份声明必须指向一个真实存在的文件,否则前缀里没有这一段。
 * 称呼和本机专属的补充都走配置(`worlds.feishu.ownerName` / `worlds.feishu.extraPrompt`),
 * 所以随包发布的这一份是通用的。
 */
const ENV = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 单张图片随消息内联等待的上限:快图随原消息一起上,慢图先放行文字、下完再补一条。 */
const IMAGE_INLINE_WAIT_MS = 1_500;
/** 单张图片下载总超时。 */
const IMAGE_FETCH_TIMEOUT_MS = 8_000;
/** 单个提交槽位的最大持有时间:防止某条消息卡死或 pushEvent 不返回导致整条提交链堵死。 */
const COMMIT_SLOT_TIMEOUT_MS = 5_000;
/** feishu_setup 等待长连接建好或报错的上限。 */
const CONNECT_WAIT_READY_MS = 4_000;

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
  /** 机器人自身的 open_id 与应用名(由 /open-apis/bot/v3/info 取回),用于群聊只理会 @ 我时精确匹配。 */
  private botOpenId = '';
  private botAppName = '';
  private botInfoInFlight?: Promise<void>;
  /** 投递侧顺序锁:解析阶段各条并发,落盘和 pushEvent 按到达顺序提交,既不顶住后消息也不乱序。 */
  private commitTail: Promise<void> = Promise.resolve();
  private starting?: Promise<void>;
  /** stop 会把它加一,进行中的 connect 看到代数变了就不再把套接字挂上。 */
  private generation = 0;
  private enabledSeen = false;
  private syncing = false;
  private readonly store: FeishuStore;
  private readonly contacts: FeishuContacts;

  constructor(private ctx: WorldContext<FeishuConfigSection>) {
    this.enabledSeen = Boolean(this.ctx.cfg.enabled);
    this.store = new FeishuStore(this.ctx.dataDir, this.ctx.timezone, (msg) => {
      this.lastError = msg;
    });
    this.contacts = new FeishuContacts(
      this.ctx.dataDir,
      () => this.client,
      (msg) => {
        this.lastError = msg;
      },
    );
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
    this.botOpenId = '';
    this.botAppName = '';
    this.botInfoInFlight = undefined;
    this.connected = false;
    this.host = undefined;
  }

  /** 取一次机器人自身的 open_id 与应用名,供群聊「只理会 @ 我」匹配。无需额外权限(只要应用开启了机器人能力)。 */
  private async ensureBotIdentity(): Promise<void> {
    if (this.botOpenId || !this.client) return;
    if (this.botInfoInFlight) return this.botInfoInFlight;
    const task = (async () => {
      try {
        const res: any = await this.client.request({
          url: '/open-apis/bot/v3/info',
          method: 'GET',
        });
        const bot = res?.bot ?? res?.data?.bot;
        const openId = String(bot?.open_id ?? '').trim();
        const appName = String(bot?.app_name ?? '').trim();
        if (openId) this.botOpenId = openId;
        if (appName) this.botAppName = appName;
      } catch {
        // 断网或凭证未就绪时忽略,下次用到再试
      } finally {
        this.botInfoInFlight = undefined;
      }
    })();
    this.botInfoInFlight = task;
    return task;
  }

  /** 群消息是否算「叫了机器人」:@ 了机器人本人,或直接回复/引用了机器人发出的消息。 */
  private async isAddressingBot(message: any): Promise<boolean> {
    const parentId = String(message?.parent_id ?? '').trim();
    const rootId = String(message?.root_id ?? '').trim();
    if ((parentId && this.store.isOwnMessage(parentId)) || (rootId && this.store.isOwnMessage(rootId))) {
      return true;
    }
    const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
    if (!mentions.length) return false;
    await this.ensureBotIdentity();
    for (const m of mentions) {
      const key = String(m?.key ?? '');
      if (key === '@_all') continue;
      const openId = String(m?.id?.open_id ?? '').trim();
      const name = String(m?.name ?? '').trim();
      if (this.botOpenId) {
        if (openId === this.botOpenId) return true;
      } else if (this.botAppName && name === this.botAppName) {
        return true;
      }
    }
    return false;
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
      if (this.store.statsOk) this.lastError = undefined;
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
            if (this.store.statsOk) this.lastError = undefined;
            void this.ensureBotIdentity();
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
            if (this.store.statsOk) this.lastError = undefined;
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
    this.botOpenId = '';
    this.botAppName = '';
    this.botInfoInFlight = undefined;
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
    this.store.noteChat(chatId, chatType, openId);
    const owner = String(cfg.ownerOpenId ?? '').trim();
    // 只限制私聊。群里其他人的话照样推进来,靠 from 区分是谁。
    if (chatType !== 'group' && owner && openId && openId !== owner) {
      const skipped = messageText(message);
      this.store.rollDay();
      this.store.stats.received += 1;
      this.store.saveStats();
      this.store.record('in', skipped || '[私聊已忽略]', chatId, String(message.message_id), this.contacts.names.get(openId) || openId, chatType, openId);
      return;
    }

    // 在第一个 await 之前占好提交槽位,保证上游看到的顺序严格等于消息到达顺序
    const commit = this.reserveCommit();
    try {
      // 群聊「只理会 @ 我或回复我」:没叫机器人的群消息只记在会话面板流水里,不推事件唤醒模型。
      if (chatType === 'group' && cfg.groupMentionOnly) {
        const addressed = await this.isAddressingBot(message);
        if (!addressed) {
          const skipped = messageText(message);
          await commit(() => {
            this.store.rollDay();
            this.store.stats.received += 1;
            this.store.saveStats();
            this.store.record('in', skipped || '[群聊未@我]', chatId, String(message.message_id), this.contacts.names.get(openId) || openId, chatType, openId);
          });
          return;
        }
      }

      // @ 的人:飞书有时只给占位不给名字,补查一下,群里才认得出叫的是谁。
      if (Array.isArray(message?.mentions)) {
        for (const m of message.mentions) {
          const id = String(m?.id?.open_id ?? '');
          if (!m?.name && id) {
            const name = await this.contacts.resolveName(id);
            if (name) m.name = name;
          }
        }
      }
      const text = messageText(message);
      if (!text) {
        await commit(() => {});
        return;
      }
      const senderName = await this.contacts.resolveName(openId);

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
        this.store.rollDay();
        this.store.stats.received += 1;
        this.store.saveStats();
        this.store.record('in', text, chatId, String(message.message_id), senderName || openId, chatType, openId);

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
              (openId ? ` · from: ${this.contacts.label(openId, senderName)}` : '') +
              `)`,
            meta: {
              chatId: String(message.chat_id ?? ''),
              messageId: String(message.message_id),
              openId,
              senderName,
              senderDept: this.contacts.depts.get(openId) ?? '',
              chatType,
            },
            ...(blobs ? { blobs } : {}),
          });
          if (this.store.statsOk && !this.connError && !localError) this.lastError = undefined;
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
              (openId ? ` · from: ${this.contacts.label(openId, senderName)}` : '') +
              `)`,
            meta: {
              chatId: String(message.chat_id ?? ''),
              messageId: String(message.message_id),
              openId,
              senderName,
              senderDept: this.contacts.depts.get(openId) ?? '',
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

    const chatId = this.store.chatOfMessage(messageId);
    if (!chatId) return;
    const cfg = this.ctx.cfg;
    const chatInfo = this.store.chats.get(chatId);
    const chatType = chatInfo?.chatType || 'p2p';
    if (chatType === 'group' && !cfg.replyToGroup) return;

    const face = REACTION_FACES[emoji] ? `${REACTION_FACES[emoji]}(${emoji})` : emoji;
    const owner = String(cfg.ownerOpenId ?? '').trim();
    const peerOpenId = openId || chatInfo?.openId || '';
    if (chatType !== 'group' && owner && peerOpenId !== owner) {
      this.store.rollDay();
      this.store.stats.received += 1;
      this.store.saveStats();
      this.store.record('in', `[表情回复] ${face} 给消息 ${messageId}`, chatId, '', this.contacts.names.get(openId) || openId, chatType, openId);
      return;
    }

    const mine = this.store.isOwnMessage(messageId);
    if (chatType === 'group' && cfg.groupMentionOnly && !mine) {
      this.store.rollDay();
      this.store.stats.received += 1;
      this.store.saveStats();
      this.store.record('in', `[表情回复] ${face} 给消息 ${messageId}`, chatId, '', this.contacts.names.get(openId) || openId, chatType, openId);
      return;
    }

    const commit = this.reserveCommit();
    try {
      const senderName = await this.contacts.resolveName(openId);
      const who = chatType === 'group' ? '飞书群' : '飞书私聊';
      await commit(async () => {
        this.store.rollDay();
        this.store.stats.received += 1;
        this.store.saveStats();
        this.store.record('in', `[表情回复] ${face} 给消息 ${messageId}`, chatId, '', senderName || openId, chatType, openId);
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
              (openId ? ` · from: ${this.contacts.label(openId, senderName)}` : '') +
              (mine ? ' · 这条是你发的' : '') +
              ')',
            meta: {
              chatId,
              messageId,
              openId,
              senderName,
              senderDept: this.contacts.depts.get(openId) ?? '',
              chatType,
              reaction: emoji,
            },
          });
          if (this.store.statsOk && !this.connError) this.lastError = undefined;
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

  private async send(args: Record<string, unknown>): Promise<ToolOutcome> {
    if (!this.client) throw Error('飞书还没连上,先在设置里填好凭证');
    if (!this.store.statsOk) throw Error(this.lastError || '账本读不了,先不发');
    this.store.rollDay();
    const limit = this.ctx.cfg.maxDailyReplies || 0;
    if (limit > 0 && this.store.stats.replies >= limit) throw Error(`今天已经回了 ${this.store.stats.replies} 条,到上限了`);

    const text = typeof args.text === 'string' ? args.text : '';
    const trimmedText = text.trim();
    const imageHandle = typeof args.image === 'string' ? args.image.trim() : '';
    const rawReaction = typeof args.reaction === 'string' ? args.reaction.trim() : '';
    const reactionType = rawReaction ? normalizeReactionType(rawReaction) : '';

    if (!trimmedText && !imageHandle && !reactionType) {
      throw Error('text、image、reaction 至少要填一项');
    }

    const messageId = typeof args.messageId === 'string' ? args.messageId.trim() : '';
    const requestedChat = typeof args.chatId === 'string' ? args.chatId.trim() : '';
    if (reactionType && !messageId) {
      throw Error('贴表情(reaction)必须传 messageId');
    }

    let chatId = requestedChat;
    if (messageId) {
      const known = this.store.chatOfMessage(messageId);
      if (!known) throw Error('没见过这条消息,不能回复或贴表情');
      if (requestedChat && requestedChat !== known) {
        throw Error('messageId 所在的会话和传入的 chatId 不一致,请核对后再发');
      }
      chatId = known;
    } else if (!chatId) {
      throw Error('要么给 messageId,要么给 chatId');
    }
    this.store.assertChat(chatId, trimmedText, this.ctx.cfg);

    // 校验并读取宿主图片句柄(仅允许 mem: 与 log:,拒绝本机文件路径或 URL)
    let imageBytes: Buffer | undefined;
    if (imageHandle) {
      if (!/^(?:mem|log):/.test(imageHandle)) {
        throw Error('image 只接受宿主的 mem: 或 log: 句柄,不接受文件路径或网址');
      }
      const blob = this.host?.blob(imageHandle);
      if (!blob || !blob.bytes?.byteLength) {
        throw Error(`找不到图片句柄(${imageHandle}),或内容为空`);
      }
      if (!String(blob.mime ?? '').toLowerCase().startsWith('image/')) {
        throw Error(`句柄(${imageHandle})不是图片类型(mime=${blob.mime || '未知'})`);
      }
      if (blob.bytes.byteLength > 10 * 1024 * 1024) {
        throw Error(`图片超过飞书 10MB 上限(${blob.bytes.byteLength} 字节)`);
      }
      imageBytes = Buffer.from(blob.bytes);
    }

    const meta = this.store.chats.get(chatId);
    let reactionId = '';
    let imageMessageId = '';
    let textMessageId = '';
    const bumpRepliesIfSent = () => {
      if (reactionId || imageMessageId || textMessageId) {
        this.store.stats.replies += 1;
        this.store.saveStats();
      }
    };

    // 1. 贴表情回复
    if (reactionType) {
      try {
        const r: any = await this.client.im.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: reactionType } },
        });
        const code = r?.code ?? r?.data?.code ?? 0;
        if (code !== 0) {
          const why = `code=${code} ${r?.msg ?? ''}`.trim();
          this.lastError = '贴表情失败:' + why;
          return { text: JSON.stringify({ status: 'failed', step: 'reaction', code, msg: r?.msg ?? '', note: '表情没贴上;检查是否开启了 im:message.reactions:write_only 权限或 emoji_type 是否正确' }), failed: true };
        }
        reactionId = String(r?.data?.reaction_id ?? r?.reaction_id ?? 'ok');
        const face = REACTION_FACES[reactionType] ? `${REACTION_FACES[reactionType]}(${reactionType})` : reactionType;
        this.store.record('out', `[表情回复] ${face} → ${messageId}`, chatId, '', '', meta?.chatType ?? '', meta?.openId ?? '');
      } catch (e) {
        const why = describeErr(e);
        this.lastError = '贴表情失败:' + why;
        return { text: JSON.stringify({ status: 'failed', step: 'reaction', error: why, note: '表情没贴上;检查是否开启了 im:message.reactions:write_only 权限或 emoji_type 是否正确' }), failed: true };
      }
    }

    // 2. 上传并发送图片
    if (imageBytes) {
      let imageKey = '';
      try {
        const up: any = await this.client.im.image.create({
          data: { image_type: 'message', image: imageBytes },
        });
        imageKey = String(up?.image_key ?? up?.data?.image_key ?? '');
        if (!imageKey) throw Error('飞书未返回 image_key');
      } catch (e) {
        const why = describeErr(e);
        this.lastError = '上传图片失败:' + why;
        bumpRepliesIfSent();
        return { text: JSON.stringify({ status: 'failed', step: 'upload_image', error: why, note: '图片上传失败;请检查 im:resource 权限与图片大小(上限 10MB)' }), failed: true };
      }

      const imgContent = JSON.stringify({ image_key: imageKey });
      let imgRes: any;
      try {
        if (messageId) {
          imgRes = await this.client.im.message.reply({
            path: { message_id: messageId },
            data: { msg_type: 'image', content: imgContent },
          });
        } else {
          imgRes = await this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: 'image', content: imgContent },
          });
        }
      } catch (e) {
        const why = describeErr(e);
        this.lastError = '发图失败:' + why;
        bumpRepliesIfSent();
        return { text: JSON.stringify({ status: 'failed', step: 'send_image', error: why }), failed: true };
      }
      const imgCode = imgRes?.code ?? imgRes?.data?.code ?? 0;
      if (imgCode !== 0) {
        this.lastError = `发图失败 ${imgCode}:${imgRes?.msg ?? ''}`;
        bumpRepliesIfSent();
        return { text: JSON.stringify({ status: 'failed', step: 'send_image', code: imgCode, msg: imgRes?.msg ?? '' }), failed: true };
      }
      imageMessageId = String(imgRes?.data?.message_id ?? '');
      this.store.record('out', `[图片] ${imageHandle}`, chatId, imageMessageId, '', meta?.chatType ?? '', meta?.openId ?? '');
    }

    // 3. 发送文字
    if (trimmedText) {
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
        bumpRepliesIfSent();
        return { text: JSON.stringify({ status: 'failed', step: 'send_text', error: why, note: '没发出去;先看是不是权限或 chatId 不对' }), failed: true };
      }

      const code = res?.code ?? res?.data?.code ?? 0;
      if (code !== 0) {
        this.lastError = `发送失败 ${code}:${res?.msg ?? ''}`;
        bumpRepliesIfSent();
        return { text: JSON.stringify({ status: 'failed', step: 'send_text', code, msg: res?.msg ?? '', note: '没发出去;先看是不是权限或 chatId 不对' }), failed: true };
      }
      textMessageId = String(res?.data?.message_id ?? '');
      this.store.record('out', text, chatId, textMessageId, '', meta?.chatType ?? '', meta?.openId ?? '');
    }

    bumpRepliesIfSent();
    if (this.store.statsOk && !this.connError) this.lastError = undefined;
    const outId = textMessageId || imageMessageId;
    return {
      text: JSON.stringify({
        status: 'sent',
        ...(outId ? { messageId: outId } : {}),
        ...(imageMessageId && textMessageId ? { imageMessageId } : {}),
        ...(reactionId ? { reaction: reactionType, reactionId } : {}),
        today: this.store.stats.replies,
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
      this.store.rollDay(); // 过了零点再打开面板时,别还显示昨天的数
      return {
        messages: this.store.thread,
        connected: this.connected,
        today: this.store.stats,
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
            this.store.rollDay();
            return {
              text: JSON.stringify({
                connected: this.connected,
                configured: Boolean(this.ctx.secret(FEISHU_SECRET_APP_ID)),
                enabled: this.ctx.cfg.enabled,
                today: { received: this.store.stats.received, replies: this.store.stats.replies },
                phase: this.phase,
                lastError: this.lastError,
              }),
            };
          }
          if (decl.name === 'feishu_reply') return await this.send(args);
          if (decl.name === 'feishu_roster') return await this.contacts.roster(String(args.chatId ?? '').trim());
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
        { label: '今日收', value: this.store.stats.received, tone: 'plain' },
        { label: '今日回', value: this.store.stats.replies, tone: 'plain' },
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
          location: this.store.threadFile(),
          danger: true,
          note: '清掉后「会话」面板就空了。',
          stat: () => `${this.store.thread.length} 条`,
          clear: () => this.store.clearThread(),
        },
        {
          key: 'feishu-today',
          label: '今日收发计数',
          kind: 'disk',
          location: this.store.statsFile(),
          danger: true,
          note: '清掉会把今天已回条数归零,每日上限跟着重算。',
          stat: () => `今日收 ${this.store.stats.received} · 回 ${this.store.stats.replies}`,
          clear: () => this.store.clearStats(),
        },
        {
          key: 'feishu-names',
          label: '认人缓存',
          kind: 'disk',
          location: this.contacts.namesFile(),
          note: 'open_id 换成名字和部门的缓存,清了下次会重新查通讯录。',
          stat: () => `${this.contacts.names.size} 人`,
          clear: () => this.contacts.clear(),
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
    this.store.rollDay();
    const name = String(this.ctx.cfg.ownerName ?? '').trim();
    const extra = String(this.ctx.cfg.extraPrompt ?? '').trim();
    return {
      'feishu.state': JSON.stringify({
        connected: this.connected,
        enabled: this.ctx.cfg.enabled,
        ownerOnly: Boolean(this.ctx.cfg.ownerOpenId),
        group: this.ctx.cfg.replyToGroup,
        groupMentionOnly: Boolean(this.ctx.cfg.groupMentionOnly),
        today: this.store.stats,
      }),
      // 没填称呼就退回「对方」,模板里两条路都说得通。
      'feishu.ownerName': name ? `「${name}」` : '对方',
      'feishu.extra': extra,
    };
  }
}

export { FEISHU_DEFAULTS };
