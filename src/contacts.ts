/**
 * 认人缓存(<dataDir>/feishu/names.json)与群成员名单拉取(feishu_roster)。
 * 维护 open_id → 名字 / 部门映射、1 小时负缓存与并发查询去重。
 */

import * as fs from 'node:fs';
import { join } from 'node:path';
import type { ToolOutcome } from 'cortico/core/types.ts';
import { describeErr } from './normalize.ts';
import { writeJsonAtomic } from './store.ts';

/** 通讯录查不到时先记一小时,免得每条消息都再打一次。面板里清认人缓存会马上重查。 */
const MISS_TTL_MS = 60 * 60 * 1000;
/** 群成员超过这个数时 roster 不再逐个补查部门,避免上百次串行请求卡死。 */
const ROSTER_DEPT_LOOKUP_MAX = 30;

export class FeishuContacts {
  readonly baseDir: string;
  /** open_id → 名字的缓存:查到一次就存下来,重启也还在,省得每条消息都去查通讯录。 */
  names = new Map<string, string>();
  /** open_id → 部门名(第一个部门)。没权限或查不到就空着。 */
  depts = new Map<string, string>();
  /** 查过名字但没有结果的时间。过期前不再打通讯录。 */
  private nameMiss = new Map<string, number>();
  /** 查过部门但没结果的时间。过期前不再打通讯录。 */
  private deptMiss = new Map<string, number>();
  /** 正在查询中的 open_id → Promise,防止并发消息同时穿透缓存重复打通讯录。 */
  private nameInFlight = new Map<string, Promise<string>>();

  constructor(
    dataDir: string,
    private getClient: () => any,
    private onError: (msg: string) => void,
  ) {
    this.baseDir = join(dataDir, 'feishu');
    this.loadNames();
  }

  namesFile(): string {
    return join(this.baseDir, 'names.json');
  }

  private loadNames(): void {
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

  private readMisses(into: Map<string, number>, raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
      const ts = Number(at);
      if (id && Number.isFinite(ts)) into.set(id, ts);
    }
  }

  saveNames(): void {
    try {
      writeJsonAtomic(this.baseDir, this.namesFile(), {
        names: Object.fromEntries(this.names),
        depts: Object.fromEntries(this.depts),
        nameMiss: Object.fromEntries(this.nameMiss),
        deptMiss: Object.fromEntries(this.deptMiss),
      });
    } catch {
      // 名单存不下不影响收发,下次再查一遍而已
    }
  }

  clear(): string {
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
  }

  private missFresh(map: Map<string, number>, id: string): boolean {
    const at = map.get(id);
    if (!at) return false;
    if (Date.now() - at > MISS_TTL_MS) {
      map.delete(id);
      return false;
    }
    return true;
  }

  /** 负缓存。没连上时不要记,免得把「还没启动」记成「这个人查不到」。 */
  private rememberMiss(map: Map<string, number>, id: string, deferSave = false): void {
    if (!id) return;
    map.set(id, Date.now());
    if (!deferSave) this.saveNames();
  }

  /**
   * 拿 open_id 换名字,查到的记进缓存。
   * 要「通讯录读取」权限,而且这个人得在应用的可用范围里,否则只会拿到空字串(不报错)。
   */
  async resolveName(openId: string, deferSave = false): Promise<string> {
    if (!openId) return '';
    const hit = this.names.get(openId);
    if (hit) {
      // 名字有缓存,部门可能还没有——补查一次,查不到就算了。
      if (!this.depts.has(openId) && !this.missFresh(this.deptMiss, openId)) await this.resolveDept(openId, deferSave);
      return hit;
    }
    const client = this.getClient();
    if (this.missFresh(this.nameMiss, openId) || !client) return '';
    const inflight = this.nameInFlight.get(openId);
    if (inflight) return inflight;
    const task = (async () => {
      try {
        const res: any = await client.contact.user.get({
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
  async resolveDept(openId: string, deferSave = false): Promise<string> {
    const client = this.getClient();
    if (!client || !openId || this.missFresh(this.deptMiss, openId)) return '';
    try {
      const res: any = await client.contact.user.get({
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
    const client = this.getClient();
    if (!client || !departmentId) return '';
    try {
      const res: any = await client.contact.department.get({
        path: { department_id: departmentId },
        params: { user_id_type: 'open_id', department_id_type: 'open_department_id' },
      });
      return String(res?.data?.department?.name ?? '');
    } catch {
      try {
        const res: any = await client.contact.department.get({
          path: { department_id: departmentId },
        });
        return String(res?.data?.department?.name ?? '');
      } catch {
        return '';
      }
    }
  }

  /** 谁在跟这个人说话:名字(+部门),查不到名字就把 open_id 原样带上,至少能分清是两个人。 */
  label(openId: string, name: string): string {
    if (!openId) return '';
    if (!name) return openId;
    const dept = this.depts.get(openId) ?? '';
    return `${name}(${openId}${dept ? ` · ${dept}` : ''})`;
  }

  /** 群成员名单:一次拉全(翻页),顺手把名字和部门补进缓存。 */
  async roster(chatId: string): Promise<ToolOutcome> {
    if (!chatId) throw Error('chatId 不能为空');
    const client = this.getClient();
    if (!client) throw Error('飞书还没连上,先在设置里填好凭证');
    const rawItems: Array<{ openId: string; rawName: string; type: string }> = [];
    let pageToken = '';
    for (let page = 0; page < 20; page += 1) {
      let res: any;
      try {
        res = await client.im.chatMembers.get({
          path: { chat_id: chatId },
          params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
        });
      } catch (e) {
        const why = describeErr(e);
        this.onError('拉群成员失败:' + why);
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
      const info: any = await client.im.chat.get({
        path: { chat_id: chatId },
        params: { user_id_type: 'open_id' },
      });
      title = String(info?.data?.name ?? '');
    } catch {
      // 群名拿不到无所谓,成员名单才是重点
    }
    return { text: JSON.stringify({ chatId, title, count: members.length, members }) };
  }
}
