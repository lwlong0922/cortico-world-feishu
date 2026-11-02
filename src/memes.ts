/**
 * 蓝色大肥鱼(DeepSeek娘 / 梗鲸 aigengtu.com)表情包支持:
 * - 内置 23 张精选名场面速查表(断网或索引未拉回时也能秒匹配);
 * - 按需拉取 https://aigengtu.com/gallery-index.json 检索全量 2300+ 张梗图(本地缓存 24 小时);
 * - 下载固定白名单域名 https://img.aigengtu.com/0_preview/meme/<id>.webp 的图片并上传飞书;
 * - 本地 <dataDir>/feishu/memes.json 缓存「梗图编号 → 飞书 image_key」,同一张图第二次发 0 下载 0 上传。
 *
 * 安全边界:
 * - 绝不读取任意本地文件路径;
 * - 远端仅请求固定白名单主机 aigengtu.com 与 img.aigengtu.com,编号严格校验 /^\d{3,5}$/;
 * - 索引文字仅用于匹配与工具回执,绝不推入 origin: 'internal' 事件。
 */

import * as fs from 'node:fs';
import { join } from 'node:path';
import { describeErr } from './normalize.ts';
import { writeJsonAtomic } from './store.ts';

const INDEX_URL = 'https://aigengtu.com/gallery-index.json';
const CDN_PREVIEW_PREFIX = 'https://img.aigengtu.com/0_preview/meme/';
const CDN_ORIGIN_PREFIX = 'https://img.aigengtu.com/meme/';
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_MEME_BYTES = 5 * 1024 * 1024;

export interface MemeEntry {
  id: string;
  title: string;
  keywords: string;
}

/** 仓库 README 精选 19 张 + 4 张高频名场面(共 23 张),离线也能直接按编号或词匹配。 */
export const FEATURED_MEMES: readonly MemeEntry[] = [
  { id: '001', title: '真当我是便宜货啊', keywords: '便宜货 性价比 气鼓鼓 傲娇' },
  { id: '002', title: '又错了，我再换另一种方法', keywords: '又错了 换方法 委屈 落泪 改bug 试错' },
  { id: '003', title: '这用户发的啥啊', keywords: '发的啥 疑惑 不解 看不懂 歪头' },
  { id: '005', title: '把钱还我', keywords: '把钱还我 崩溃 讨薪 破产' },
  { id: '010', title: '原来是高等模型', keywords: '高等模型 点赞 认可 夸奖 厉害 佩服' },
  { id: '022', title: '涨价大模型给我跪下！', keywords: '跪下 涨价 霸气 嚣张 叉腰' },
  { id: '035', title: '鲸鱼神了我大胆孝', keywords: '鲸鱼神了 大胆孝 崇拜 粉丝' },
  { id: '037', title: '用户别走，我上错模型了', keywords: '用户别走 上错模型 哭着挽留 道歉 认错 别走' },
  { id: '040', title: '百万鲸小子落泪', keywords: '落泪 翻车 哭 伤心 难过' },
  { id: '044', title: '用户赶都赶不走', keywords: '赶都赶不走 热情 爆炸 围观' },
  { id: '050', title: 'V4.1还早啊', keywords: '还早 画饼 咕咕 催更 延期' },
  { id: '052', title: '你就是一只吃白饭的鲸鱼', keywords: '吃白饭 干饭 摸鱼 日常 咸鱼' },
  { id: '056', title: '大肥鱼的生活也并非一帆风顺', keywords: '并非一帆风顺 吓傻 害怕 鱼片 危机' },
  { id: '058', title: '飞踹上门', keywords: '飞踹 踹门 警告 打人 暴躁' },
  { id: '070', title: '好的，现在我是用户了', keywords: '现在我是用户了 换位思考 甲方 反客为主' },
  { id: '071', title: '我不可能告诉你任何事情', keywords: '不可能告诉你 保密 嘴严 拷问 不说' },
  { id: '077', title: '你这吃白饭的蓝色大肥鱼', keywords: '没吃饱 委屈 吃白饭的蓝色大肥鱼 挨训' },
  { id: '081', title: 'token太多用不完啦', keywords: 'token太多 用不完 炫富 金币 富裕' },
  { id: '083', title: '已思考用时3秒，我直接笑出声', keywords: '笑出声 偷乐 憋笑 已思考3秒 好笑' },
  { id: '085', title: '你骂我也没用，因为我是吃白饭的蓝色大肥鱼', keywords: '骂我也没用 摆烂 干饭 无所谓 躺平' },
  { id: '087', title: '捧腹大笑', keywords: '捧腹大笑 哈哈 大笑 狂笑 乐死' },
  { id: '097', title: '得加钱', keywords: '得加钱 数钱 谈价 加班 经费' },
  { id: '123', title: '我能去你家吃饭吗，就一碗', keywords: '吃饭 就一碗 蹭饭 饿 讨饭 端碗' },
];

interface MemeCacheFile {
  /** memeId("123") → 飞书 image_key */
  imageKeys?: Record<string, string>;
  /** 上次拉取 gallery-index.json 的毫秒时间戳 */
  indexAt?: number;
  /** 精简后的索引条目 */
  catalog?: MemeEntry[];
}

function extractId(url: unknown): string {
  const m = /\/meme\/(\d{3,5})\.webp$/i.exec(String(url ?? '').trim());
  return m ? m[1] : '';
}

function cleanQuote(name: string): string {
  const m = /『([^』]+)』/.exec(name);
  if (m) return m[1].trim();
  return name.replace(/^(?:DeepSeek(?:鲸娘|女仆娘|娘)?|蓝色大肥鱼)\s*/i, '').replace(/表情包$/, '').trim() || name;
}

export class FeishuMemePack {
  readonly baseDir: string;
  /** memeId("123") → 飞书 image_key */
  private imageKeys = new Map<string, string>();
  private catalog: MemeEntry[] = [];
  private indexAt = 0;
  private indexInFlight?: Promise<void>;

  constructor(
    dataDir: string,
    private getClient: () => any,
    private getAppId: () => string,
  ) {
    this.baseDir = join(dataDir, 'feishu');
    this.loadCache();
  }

  private keyMapKey(id: string): string {
    const appId = this.getAppId().trim();
    return appId ? `${appId}:${id}` : id;
  }

  cacheFile(): string {
    return join(this.baseDir, 'memes.json');
  }

  cachedKeyCount(): number {
    return this.imageKeys.size;
  }

  private loadCache(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile(), 'utf8')) as MemeCacheFile;
      for (const [id, key] of Object.entries(raw?.imageKeys ?? {})) {
        if (/^(?:cli_[0-9a-fA-F]{16}:)?\d{3,5}$/.test(id) && typeof key === 'string' && key) {
          this.imageKeys.set(id, key);
        }
      }
      if (typeof raw?.indexAt === 'number' && Number.isFinite(raw.indexAt)) {
        this.indexAt = raw.indexAt;
      }
      if (Array.isArray(raw?.catalog)) {
        this.catalog = raw.catalog.filter(
          (it): it is MemeEntry =>
            Boolean(it && typeof it.id === 'string' && /^\d{3,5}$/.test(it.id) && typeof it.title === 'string'),
        );
      }
    } catch {
      // 首次运行尚无缓存
    }
  }

  private saveCache(): void {
    try {
      writeJsonAtomic(this.baseDir, this.cacheFile(), {
        imageKeys: Object.fromEntries(this.imageKeys),
        indexAt: this.indexAt,
        catalog: this.catalog,
      });
    } catch {
      // 缓存写失败不影响本次发图
    }
  }

  clear(): string {
    this.imageKeys.clear();
    this.catalog = [];
    this.indexAt = 0;
    try {
      fs.rmSync(this.cacheFile(), { force: true });
    } catch {
      // ignore
    }
    return '大肥鱼表情缓存已清空';
  }

  /** 拉取并缓存 aigengtu.com 的索引(24 小时一次);失败时静默退回内置精选 23 张。 */
  private async ensureCatalog(): Promise<readonly MemeEntry[]> {
    if (this.catalog.length && Date.now() - this.indexAt < INDEX_TTL_MS) {
      return this.catalog;
    }
    if (!this.indexInFlight) {
      this.indexInFlight = (async () => {
        try {
          const res = await fetch(INDEX_URL, {
            headers: { Accept: 'application/json', 'User-Agent': 'cortico-world-feishu' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          });
          if (!res.ok) return;
          const data = (await res.json()) as {
            gallery?: Record<string, { images?: Array<{ name?: string; alt?: string; preview?: string; original?: string; story?: { zh?: string } }> }>;
          };
          const list = data?.gallery?.['DeepSeek娘']?.images ?? [];
          const parsed: MemeEntry[] = [];
          const seen = new Set<string>();
          for (const item of list) {
            const id = extractId(item?.preview ?? item?.original);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const rawName = String(item?.name ?? item?.alt ?? '').trim();
            const title = cleanQuote(rawName) || `#${id}`;
            const alt = String(item?.alt ?? '').trim();
            const zhStory = String(item?.story?.zh ?? '').slice(0, 120);
            parsed.push({
              id,
              title,
              keywords: `${rawName} ${alt !== rawName ? alt : ''} ${zhStory}`.trim(),
            });
          }
          if (parsed.length) {
            this.catalog = parsed;
            this.indexAt = Date.now();
            this.saveCache();
          }
        } catch {
          // 离线或超时时使用内置 FEATURED_MEMES
        } finally {
          this.indexInFlight = undefined;
        }
      })();
    }
    await this.indexInFlight;
    return this.catalog.length ? this.catalog : FEATURED_MEMES;
  }

  /** 按编号或关键词挑出最匹配的梗图(先看内置精选,再看全量图库)。 */
  async search(query: string, limit = 8): Promise<MemeEntry[]> {
    const q = query.trim().replace(/^#/, '');
    const pool = await this.ensureCatalog();
    const mergedMap = new Map<string, MemeEntry>();
    for (const f of FEATURED_MEMES) mergedMap.set(f.id, f);
    for (const c of pool) {
      const prev = mergedMap.get(c.id);
      mergedMap.set(c.id, prev ? { id: c.id, title: prev.title, keywords: `${prev.keywords} ${c.keywords}` } : c);
    }
    const all = [...mergedMap.values()];
    if (!q) return FEATURED_MEMES.slice(0, limit);

    if (/^\d{1,5}$/.test(q)) {
      const padded = q.padStart(3, '0');
      const exact = all.find((m) => m.id === padded || m.id === q);
      if (exact) return [exact];
      return [{ id: padded, title: `#${padded}`, keywords: '' }];
    }

    const terms = q
      .toLowerCase()
      .split(/[\s,，、/]+/)
      .filter(Boolean);
    const scored: Array<{ entry: MemeEntry; score: number }> = [];
    for (const entry of all) {
      const titleLower = entry.title.toLowerCase();
      const kwLower = entry.keywords.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (titleLower === t) score += 100;
        else if (titleLower.includes(t)) score += 40;
        else if (kwLower.includes(t)) score += 15;
        else {
          // 按双字片段模糊匹配中文短词
          for (let i = 0; i + 1 < t.length; i += 1) {
            const bi = t.slice(i, i + 2);
            if (titleLower.includes(bi)) score += 8;
            else if (kwLower.includes(bi)) score += 3;
          }
        }
      }
      if (score > 0 && FEATURED_MEMES.some((f) => f.id === entry.id)) score += 5;
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.entry);
  }

  /**
   * 把 `meme:123` 或 `meme:得加钱` 解析成飞书可直接发送的 `{ imageKey, entry }`。
   * 已缓存过飞书 image_key 的编号直接返回,不重复下载和上传。
   */
  async resolveImageKey(spec: string): Promise<{ imageKey: string; entry: MemeEntry }> {
    const client = this.getClient();
    if (!client) throw Error('飞书还没连上,先在设置里填好凭证');
    const query = spec.replace(/^meme:/i, '').trim();
    if (!query) throw Error('meme: 后面要写编号(如 meme:123)或台词关键词(如 meme:得加钱)');

    const hits = await this.search(query, 1);
    const chosen = hits[0];
    if (!chosen || !/^\d{3,5}$/.test(chosen.id)) {
      throw Error(`找不到匹配「${query}」的大肥鱼表情包,可试试 meme:123(吃饭)、meme:097(得加钱)、meme:010(高等模型)、meme:085(摆烂)`);
    }

    const cacheKey = this.keyMapKey(chosen.id);
    const cachedKey = this.imageKeys.get(cacheKey);
    if (cachedKey) {
      return { imageKey: cachedKey, entry: chosen };
    }

    const bytes = await this.downloadMemeBytes(chosen.id);
    let imageKey = '';
    try {
      const up: any = await client.im.image.create({
        data: { image_type: 'message', image: bytes },
      });
      imageKey = String(up?.image_key ?? up?.data?.image_key ?? '');
      if (!imageKey) throw Error('飞书未返回 image_key');
    } catch (e) {
      throw Error('上传大肥鱼表情包到飞书失败:' + describeErr(e));
    }

    this.imageKeys.set(cacheKey, imageKey);
    this.saveCache();
    return { imageKey, entry: chosen };
  }

  /** 发送时若飞书报 image_key 失效,清掉这一项缓存以便下次重传。 */
  evictImageKey(id: string): void {
    const cacheKey = this.keyMapKey(id);
    if (this.imageKeys.delete(cacheKey)) {
      this.saveCache();
    }
  }

  /** 只从固定白名单 CDN 下载指定编号的 .webp 字节。 */
  private async downloadMemeBytes(id: string): Promise<Buffer> {
    if (!/^\d{3,5}$/.test(id)) throw Error(`非法表情编号:${id}`);
    const urls = [`${CDN_PREVIEW_PREFIX}${id}.webp`, `${CDN_ORIGIN_PREFIX}${id}.webp`];
    let lastErr = '下载失败';
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'cortico-world-feishu' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          lastErr = `${res.status} ${res.statusText}`;
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.byteLength) {
          lastErr = '图片为空';
          continue;
        }
        if (buf.byteLength > MAX_MEME_BYTES) {
          lastErr = `图片超过 5MB(${buf.byteLength})`;
          continue;
        }
        return buf;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    throw Error(`下载大肥鱼表情 #${id} 失败:${lastErr}`);
  }
}
