/**
 * 飞书消息拍平、表情符号映射与错误描述纯函数。
 * 不持有任何运行时状态,便于独立测试与复用。
 */

/**
 * 表情回复的 emoji_type 换成看得懂的符号。飞书给的是大写英文键,
 * 对不上号的(自定义表情等)原样带上,不猜。
 */
export const REACTION_FACES: Record<string, string> = {
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

const FACE_TO_REACTION: Record<string, string> = {
  '👍': 'THUMBSUP',
  '👎': 'THUMBSDOWN',
  '❤️': 'HEART',
  '❤': 'HEART',
  '😄': 'SMILE',
  '😆': 'LAUGH',
  '😭': 'CRY',
  '😮': 'SURPRISED',
  '🤔': 'THINKING',
  '👌': 'OK',
  '✅': 'DONE',
  '🔥': 'FIRE',
  '👏': 'CLAP',
  '💪': 'MUSCLE',
  '🙏': 'PRAY',
  '🎉': 'PARTY',
};

export function normalizeReactionType(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (FACE_TO_REACTION[trimmed]) return FACE_TO_REACTION[trimmed];
  const upper = trimmed.toUpperCase();
  if (REACTION_FACES[upper]) return upper;
  if (/^[A-Za-z0-9_]{1,64}$/.test(trimmed)) return trimmed;
  throw Error(`不支持的表情类型(${trimmed}),请传飞书 emoji_type(如 THUMBSUP、OK、DONE、HEART)`);
}

/**
 * 把 `@_user_1` 这类占位换成「@名字(open_id)」。
 * 飞书把被 @ 的人放在 message.mentions 里,名字也给,所以群里能知道叫的是谁;
 * 对不上号的保留一个 [@],别把整句吞掉。sender 的名字飞书不给,只有 open_id。
 */
export function stripMentions(s: string, mentions?: any[]): string {
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
export function describeErr(e: unknown): string {
  const anyErr = e as any;
  const data = anyErr?.response?.data;
  const code = data?.code ?? anyErr?.code;
  const msg = data?.msg ?? anyErr?.msg;
  if (code || msg) return `code=${code ?? '?'} ${msg ?? ''}`.trim();
  return e instanceof Error ? e.message : String(e);
}

/** 一条消息里所有能下的图:普通图片和富文本里夹的图。表情包不在这里,飞书不给下。 */
export function imageKeys(message: any): string[] {
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
export function messageText(message: any): string {
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
