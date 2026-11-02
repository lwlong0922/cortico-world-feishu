# Changelog

## 0.2.1

- **接入「蓝色大肥鱼(DeepSeek娘)」表情包(`src/memes.ts`)**:
  - `feishu_reply` 的 `image` 参数新增支持 `meme:<编号>`(如 `meme:123`、`meme:097`)或 `meme:<台词关键词>`(如 `meme:蹭饭`、`meme:得加钱`、`meme:摸鱼`),内置 23 张高频名场面速查表并支持按需从固定白名单(`aigengtu.com`)检索全量 2300+ 张梗图。
  - 已上传飞书的 `image_key` 按应用 `appId` 隔离缓存在 `<dataDir>/feishu/memes.json`(面板「数据」页签可一键清空,发送报错失效时自动驱逐),后续同图秒发。
  - `cortico.tags` 补入 `internet` 标签,重新生成 `describe.json`。

## 0.2.0

- **群聊「只理会 @ 我或回复我的消息」开关**(`worlds.feishu.groupMentionOnly`,默认关闭):
  - 打开后,群聊里只有 @ 机器人本人(通过 `/open-apis/bot/v3/info` 自动识别机器人 `open_id` / 应用名,排除 `@_all`)或直接回复/引用机器人所发消息(`parent_id` / `root_id`)的句子与表情回复才推进上下文;其他群友闲聊只记在「会话」面板流水里,不唤醒模型。
- **`feishu_reply` 支持贴表情回复(`reaction`)**:
  - 可传飞书 `emoji_type`(如 `THUMBSUP`、`OK`、`DONE`、`HEART`、`SMILE`、`THINKING` 等,也兼容直接传常用 emoji 符号)给指定 `messageId` 添加表情回复;可单独贴表情,也可与文字/图片同次调用发出。
  - `feishu-permissions.json` 补入 `im:message.reactions:write_only`。
- **`feishu_reply` 支持发送图片(`image`)**:
  - 接受宿主的 `mem:` / `log:` 图片句柄(严格拒绝本机文件路径与任意外部 URL),经 `im.image.create` 上传后发出。
- **WebUI 面板居中与卡片对齐**:
  - `webui.js` 的「会话」与「凭证」面板改用标准 `ui.sheet` 卡片并加 `1120px` 居中壳,消除顶部多余分隔线并与内置页签视觉对齐。
- **代码模块化拆分**:
  - 原 `src/world.ts` 拆分为 `src/normalize.ts`(纯函数消息拍平与表情映射)、`src/store.ts`(本地持久化与会话白名单校验)、`src/contacts.ts`(通讯录认人缓存与群成员名单)和 `src/world.ts`(连接与收发主干)四个模块。

## 0.1.5

- `package.json` 补齐 GitHub `repository`、`homepage` 与 `bugs` 地址(`https://github.com/lwlong0922/cortico-world-feishu`)。

## 0.1.4

- 重新生成 `describe.json`,与 `src/ENV_PROMPT.md` 新增的表情回复说明保持一致。
- 表情回复(`onReaction`)补齐私聊 `ownerOpenId` 白名单校验、接入 `reserveCommit()` 顺序提交链(异常时回滚 `seenReactions`),且记流水时不复用被点赞原消息的 `messageId`。
- 补充 README 与 CHANGELOG 中关于表情回复缓存恢复范围及飞书后台权限/事件升级配置的说明。

## 0.1.3

- 新增**表情回复**事件:订阅 `im.message.reaction.created_v1`,有人给消息点赞/加表情时,以 `origin: 'external'` 推一条 `feishu.message` 上来(正文形如 `[飞书群] [表情回复] 给消息 om_xxx 加了表情 👍(THUMBSUP)`),同一条消息自己发的会标注「这条是你发的」。
  - 事件本身不带 `chat_id`,靠本地记过的 messageId→chatId(`thread.json` / 进程内缓存)反查;没见过那条消息就不推,免得推出一个没法回的会话。
  - 不认识的表情类型(自定义表情等)原样带上 `emoji_type`,不猜。
  - 机器人自己点的表情(`operator_type: 'app'`)忽略;事件按 `event_id` 去重;群里受「是否响应群聊」开关约束。
- 飞书后台配套配置:`feishu-permissions.json` 新增 `im:message.reactions:read`。已建好的应用升级后若想收到表情回复,需在飞书后台补勾权限 `im:message.reactions:read`、在「事件与回调 → 事件配置」添加 `im.message.reaction.created_v1`(消息被添加表情回复),并创建版本发布;不改也能照常收发消息,只是收不到点赞。

## 0.1.2

- 标签对齐官方词表:`cortico.tags` 改为 `im`、`requires-key`、`external-setup`,移除词表外的 `chat` 与测试期 `experimental`。
- 补齐包内 `LICENSE`(MIT)、`package.json` 的 `author` 与英文 `locales.en` 描述。
- `feishu-permissions.json` 去掉未使用的 `im:message:readonly`,与 README 所列权限及代码实际调用的接口严格一致。
- 对齐 README 与 CHANGELOG 中关于本地存储文件(`state.json` / `thread.json` / `chats.json` / `names.json`)、WebUI 面板及 `feishu_roster` 部门查询行为的说明。

## 0.1.1 · 首个发布版

0.1.0 从没发出去过,只在本机跑;这一版是第一次对外。

- 「凭证」面板:在扩展页里直接填 App ID / App Secret,存在本机 `.env`,页面只回显 App ID,Secret 只报「设没设」。填完自动重连,连不上把飞书错误码显示在同一页。`feishu_setup` 和面板走同一段保存逻辑。
- 发送和拉名单的失败会写进 `lastError`(以前只有一行 `Error: xxx`),重启进程或发成功才清。
- 收消息不再顶住飞书的 3 秒 ACK(图片下载慢也不拖后面的消息);下载失败的图不再被后一条推送成功掩盖。
- `feishu_setup` 等到真的连上/失败才返回,不再把「正在连」报成成功。
- 只回复私聊里的本人;群和未知会话的正文里带内部编号直接拒绝。
- 群成员名单超过 30 人时跳过逐个补查部门,避免大群串行请求卡死;拉名单期间延后落盘,末尾统一写一次 `names.json`。
- 图片下载的流一定关掉;慢图改成下完再补推一条附件事件。

## 0.1.0

首个版本。

- 用飞书企业自建应用的长连接(`im.message.receive_v1`)收发私聊和群聊,不用公网 IP、不用开端口。
- 工具:`feishu_reply`(回某条消息或发到某个会话)、`feishu_status`(连接状态与今日收发)、`feishu_roster`(只读拉群成员)、`feishu_setup`(存 App 凭证并重连,凭证存进宿主秘密配置、不回显)。
- 「会话」面板:收发流水、连接状态、今日计数,可清空每日计数和认人缓存。
- 认人:消息里带 `名字(ou_… · 部门)`,`@` 也带名字;缓存落在 `<dataDir>/feishu/names.json`,可一键清空。
- 收图:普通图片和富文本 `post` 里夹的图能取,一条最多 3 张。表情包只留 `[表情]` 占位,不去下载。
- 配置项:启用开关、只理会某个 open_id、群里说话是否推进来、每天最多回几条、怎么称呼你、补充说明(本机专属)。
- 环境说明模板与配置解耦:`{{feishu.state}}` / `{{feishu.ownerName}}` / `{{feishu.extra}}`,同一个包谁装都能用。
- 已知限制:历史消息还不能回读;语音/视频/文件只有占位,不转写不下载;部门要应用和使用者在同一租户才查得到。
- 「只理会这个人」只作用于私聊。别人的私聊记在会话面板里,不推进来;群里其他人的消息照样进来。
- 只能发到已经收过消息的会话。群里以及还分不清是不是私聊的会话,正文里带 open_id 或 chatId 会直接拒绝。
- 通讯录查不到名字或部门时记一小时,不再每条消息重试,也不再把这件事写成连接错误。表情包不再去下载。
- 账本读不了时不把今日计数清零,发送先停。App ID 和 App Secret 都合法才写入。
