import type { ConfigGroup } from 'cortico/core/types.ts';

export interface FeishuConfigSection {
  enabled: boolean;
  /** 只理会这个人的私聊（open_id）；留空表示谁都理会（不推荐）。 */
  ownerOpenId: string;
  /** 群里说的也推给我。默认打开;只想听私聊就关掉。 */
  replyToGroup: boolean;
  /** 群里只理会 @ 我或回复我的消息;关着时群里每句话都推进来。 */
  groupMentionOnly: boolean;
  /** 每天最多回多少条，防止刷屏。0 表示不限。 */
  maxDailyReplies: number;
  /** 怎么称呼对方(会话面板、提示词里用)；留空就只说「对方」。 */
  ownerName: string;
  /** 本机专属的补充说明，接在环境说明后面：口癖、气泡镜像、别的规矩。留空就没有。 */
  extraPrompt: string;
}

/** 凭证存在宿主的秘密配置里，不进配置文件。 */
export const FEISHU_SECRET_APP_ID = 'FEISHU_APP_ID';
export const FEISHU_SECRET_APP_SECRET = 'FEISHU_APP_SECRET';

export const FEISHU_DEFAULTS: FeishuConfigSection = {
  // 宿主约定:定义里的 enabled 必须是 false,开不开由部署决定。
  enabled: false,
  ownerOpenId: '',
  replyToGroup: true,
  groupMentionOnly: false,
  maxDailyReplies: 300,
  ownerName: '',
  extraPrompt: '',
};

export const FEISHU_CONFIG_GROUP: ConfigGroup = {
  id: 'world:feishu',
  owner: 'world:feishu',
  schema: {
    type: 'object',
    title: '飞书',
    properties: {
      'worlds.feishu.enabled': {
        type: 'boolean',
        title: '启用飞书连接',
        description: '关掉后断开长连接，不再收消息。打开后重新接上。',
        'x-hot': true,
      },
      'worlds.feishu.ownerOpenId': {
        type: 'string',
        title: '只理会这个人的私聊（open_id）',
        description: '只影响私聊。留空表示私聊不限制。填了以后，别人的私聊只记在会话面板里，不推进来。群消息不受这一项影响。',
        'x-hot': true,
      },
      'worlds.feishu.replyToGroup': {
        type: 'boolean',
        title: '群里说话也推进来',
        description: '打开后群聊消息也推给我(别人说的也算)。只想听私聊就关掉。',
        'x-hot': true,
      },
      'worlds.feishu.groupMentionOnly': {
        type: 'boolean',
        title: '群里只理会 @ 我或回复我的消息',
        description: '打开后，群聊里只有 @ 机器人或直接回复机器人消息的句子才推进上下文；其他群友闲聊只记在「会话」面板里，不唤醒模型。',
        'x-hot': true,
      },
      'worlds.feishu.maxDailyReplies': {
        type: 'integer',
        title: '每天最多回几条',
        minimum: 0,
        maximum: 5000,
        description: '0 表示不限。超过后不再发，等到第二天。',
        'x-hot': true,
      },
      'worlds.feishu.ownerName': {
        type: 'string',
        title: '怎么称呼你',
        description: '会话面板和提示词里用它称呼你；留空就只说「对方」。',
        'x-hot': true,
      },
      'worlds.feishu.extraPrompt': {
        type: 'string',
        title: '补充说明（本机专属）',
        description: '接在环境说明后面，写口癖、气泡画像、只在本机成立的规矩。留空就没有。',
        format: 'textarea',
      },
    },
  },
};
