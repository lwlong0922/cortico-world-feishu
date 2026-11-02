# 飞书 · Cortico World

让飞书那头也是同一个 Bot 本人,不是分身:飞书私聊/群聊来的消息推给 Persona,回复用 `feishu_reply` 发回去。走飞书企业自建应用的**长连接**,不用公网 IP、不用开端口。

Cortico World。宿主:Coopanion(World API 6)。依赖 `@larksuiteoapi/node-sdk`。

## 它做什么

- 起一条飞书长连接(`im.message.receive_v1` 收消息、`im.message.reaction.created_v1` 收表情回复),推进 `host.pushEvent({ type: 'feishu.message' })`。
- 工具 `feishu_reply`:回复某条消息(`messageId`)或发到某个会话(`chatId`);支持发文字(`text`)、发宿主图片句柄(`image`,仅限 `mem:` / `log:`)以及给消息贴表情回复(`reaction`,如 `THUMBSUP` / `OK` / `DONE`)。
- 工具 `feishu_status`:连没连上、今天收发了多少、上次错在哪。
- 工具 `feishu_roster`:拉一个群的成员名单(open_id + 名字 + 部门,权限够才有名字和部门)。
- 工具 `feishu_setup`:存 App ID / App Secret(进宿主的秘密配置,不回显),重连。
- 「凭证」面板:同一件事的界面版 —— 填 App ID / App Secret(Secret 用密码框,存进去就不再显示),保存后自动重连,连不上把飞书错误码显示在同一页。
- 「会话」面板:收发流水、连接状态、今日计数。
- 本地状态(`dataDir/feishu/`):`state.json`(每日收发计数,防刷屏)、`thread.json`(最近 300 条会话流水)、`chats.json`(见过的会话 chatId 与类型)、`names.json`(open_id 与显示名/部门缓存)。前两者和认人缓存都可以在扩展页「数据」页签一键清空。

## 在飞书里建一个应用(一步步)

前提:一个飞书账号,最好是企业版/团队版;个人版也能建,但通讯录接口只认同租户的人(见「能力边界」里的部门那条)。

1. 浏览器打开 `https://open.feishu.cn/app`,用要装机器人的那个账号登录,进「开发者后台」。
2. 点「创建企业自建应用」,填名称、描述、图标,创建。
3. 左侧「添加应用能力」→ 勾上「机器人」。没有这一步,应用发不出消息。
4. 左侧「权限管理」→「批量导入 / 导出权限」,清掉弹窗里的示例,把包里的 `feishu-permissions.json` 整个粘进去,下一步 → 确认新增权限。里面有:
   - `im:message.p2p_msg:readonly` — 收私聊
   - `im:message.group_msg`(「获取群组中所有消息」)/ `im:message.group_at_msg:readonly`(只收 @ 机器人的)— 群聊
   - `im:message:send_as_bot` — 以机器人身份发消息
   - `im:message.reactions:read`、`im:message.reactions:write_only` — 收「有人给消息点了表情」的事件、以机器人身份给消息贴表情回复(不开也能正常收发文字和图片)
   - `im:resource` — 取消息里的图片/文件资源、上传要发的图片
   - `im:chat:readonly`、`im:chat.members:read` — 拉群信息和群成员
   - `contact:user.base:readonly`、`contact:user.department:readonly`、`contact:department.base:readonly` — 认人(名字/部门)

   没勾的权限不会生效;导入后仍要按第 7 步创建版本并发布。手点也行,照这份清单搜关键字。
5. 同一页的「数据权限」:把可用范围设成要用它的人(或全员)。范围不含某人,通讯录接口会回 `41050 no user authority error`。
6. 左侧「事件与回调」→「事件配置」:订阅方式选 **使用长连接接收事件**(不用公网 IP、不用开端口、不用回调地址),然后「添加事件」,搜 `im.message.receive_v1`(接收消息 v2.0)勾上。想连点赞也知道,再把 `im.message.reaction.created_v1`(消息被添加表情回复)一起勾上——不勾也不会报错,只是收不到。
7. 左侧「版本管理与发布」→「创建版本」,填版本号(如 `1.0.0`)和更新说明,「申请发布」。个人版直接通过;企业版要管理员在飞书里批。
8. 拿凭证:左侧「凭证与基础信息」里的 **App ID** 和 **App Secret**。
9. 把机器人拉进群:「群设置 → 群机器人 → 添加机器人」选你的应用。外部群要另外开「对外共享」并重新发版。
10. 回到这里:扩展配置页打开「启用飞书连接」,再打开「凭证」页签,把 **App ID** 和 **App Secret** 填进去保存(也可以用 `feishu_setup` 让模型代填)。两者都存在宿主的秘密配置里,页面只回显 App ID。

排错顺序:配置页的连接状态 → `feishu_status` 看 `lastError` → 权限改过没发版 → 数据权限范围 → 机器人有没有进群。

## 能力边界(先说清楚,别当 bug 报)

- **断线期间的消息不补**:长连接只在进程活着时有效。重启、断网、机器睡眠期间,别人发的消息这个扩展不会知道,也没有补拉(`im:message:readonly` 的回读还没写),只有连上之后的消息能收到。
- **只能发到见过的会话**:`feishu_reply` 只认进程里收到过消息的 chatId / messageId。想主动给某人私聊、或者新建群发通知,现在做不到。
- **发送格式限制**:支持发纯文本、发图片(仅接受宿主的 `mem:` / `log:` 句柄,拒绝本机文件路径与外部网址)以及给消息贴表情回复(`reaction`);不能在正文里 @ 人,不能发富文本、卡片、按钮;链接也是干链接。
- **凭证只能填、不能清**:面板没有「清除」。换应用就直接覆盖填一遍;想回到「未填」状态得手工改部署根目录的 `.env`。
- **表情包(sticker)的图取不到**:飞书「获取消息资源文件」接口明确不支持表情包资源,只能拿到 `[表情]` 占位。普通图片、富文本里夹的图可以取。
- **表情回复有个前提**:点赞事件(`im.message.reaction.created_v1`)本身不带 `chat_id`,扩展靠本地记过的 messageId→chatId 反查(进程内最多记 2000 条,重启时从 `thread.json` 恢复最近 300 条)。没见过或已滑出缓存的老消息被点赞就不推了;也没开「表情被取消」(`deleted_v1`)——只推加上去的。
- **语音 / 视频 / 文件**:只有占位文字,不转写、不下载。
- **部门**:应用和用户不在同一个租户时,通讯录接口查不到,`from:` 里就只有名字(名字来自群成员列表)。
- **重名分不清**:名字来自群成员列表的显示名。两个人同名时,`from:` 后面那个 open_id 才是不重样的依据。

## 报错码对照

先看配置页的连接状态和 `feishu_status` 的 `lastError`,再对照这几条(以飞书后台文案为准,这里只写常见原因):

| 码 | 常见意思 | 多半是哪里 |
|---|---|---|
| `41050` | `no user authority error` | 应用「数据权限」的范围里没有这个使用者;或者应用和使用者不在同一个租户 |
| `99991663` | `Invalid access token` | 权限改过但没创建版本发版;应用被停用;或者几个进程共用同一份凭证互相顶掉了 token |
| `230002` | 机器人不在这个会话里 | 没把机器人拉进群,或者被移出群了 |

改完权限记得回「版本管理与发布」建版本发版,权限才真的生效。

## 隐私与安全

- App Secret 存宿主秘密配置,不进配置文件,不会被回读显示。
- 认人缓存里有 open_id 和名字,存在 `<dataDir>/feishu/names.json`;面板上可以一键清空。
- 群消息会带上发信人的 `名字(ou_… · 部门)`,方便判断是谁在说话;这些内部编号不该出现在回复里。

## 结构

- `src/definition.ts` — `WorldDefinition`,注册工具与事件。
- `src/world.ts` — 长连接生命周期、收发事件主流程、取图、发图/发文字/贴表情、面板与工具接线。
- `src/normalize.ts` — 消息体拍平(`messageText` / `stripMentions` / `imageKeys`)、表情映射与错误格式化纯函数。
- `src/store.ts` — 本地状态持久化(`thread.json` / `chats.json` / `state.json`)、已知会话与出站安全校验。
- `src/contacts.ts` — 认人缓存(`names.json`)、部门查询与 `feishu_roster` 群成员拉取。
- `src/tools.ts` / `src/config.ts` — 工具声明、配置项。
- `src/ENV_PROMPT.md` — 环境说明模板,带 `{{feishu.state}}` / `{{feishu.ownerName}}` / `{{feishu.extra}}` 三个变量;称呼和本机专属的规矩都从配置来,所以这份是通用的。
- `webui.js` — 「会话」与「凭证」两个面板。

## 配置项(World 配置页)

- **启用飞书连接** — 总开关。
- **只理会这个人的私聊(open_id)** — 只限私聊。填了就只应这个人;别人的私聊只记在会话面板里,不推进来。群里其他人的消息照样进来。
- **群里说话也推进来** — 群聊是否也进上下文;只想听私聊就关掉。
- **群里只理会 @ 我或回复我的消息** — 打开后,群聊里只有 @ 机器人或直接回复机器人消息的句子才推进上下文;其他群友闲聊只记在「会话」面板里,不唤醒模型。
- **每天最多回几条** — 防刷屏,0 不限。
- **怎么称呼你** — 会话面板和提示词里用这个称呼你;留空就是「对方」。
- **补充说明(本机专属)** — 接在环境说明后面:口癖、气泡镜像、只在本机成立的规矩,想写什么写什么,留空就没有。

## 装法

1. 把包目录放在本机某处,在 Coopanion「扩展页 → World 扩展 → 手动安装 → 从本机目录安装」里选这个目录。
2. 重启进程。
3. World 列表启用「飞书」,第一次在「凭证」页签填 App ID / App Secret(或让模型调 `feishu_setup`)。

## 开发

改 `src/` 下的源码要**重启进程**才生效(宿主直接读源码,不做编译)。

## 分享给别人

三条路,从省事到正经:

1. **发目录** — 把整个包目录(去掉 `node_modules`)打成 zip 发给对方,对方在扩展页「手动安装 → 从本机目录安装」选解压后的目录,再重启进程。最省事,适合给一两个人用。
2. **发 npm** — `npm publish` 之后别人在扩展页搜包名就能装。`keywords` 里的 `cortico-world` 是市场搜到它的依据;`files` 只放要发的东西(`src`、`webui.js`、`describe.json`、`icon.svg`、`feishu-permissions.json`、`README.md`、`CHANGELOG.md`、`LICENSE`)。
3. **进官方扩展市场与申请认证** — 发到 npm 后索引仓 `Pal-AI-Lab/cortico-extensions` 会定时收录(急的话开 `[sync] cortico-world-feishu` 马上同步);想申请官方认证徽标则开 `[certify] cortico-world-feishu`。

发布前自查(在 Cortico 仓库跑 `pnpm check:extension <包目录>`,报告最后一段就是这份清单):

- `CHANGELOG.md` 里有 `## <版本号>` 一段,市场按它显示这一版的更新日志;版本号和 `package.json` 的 `version` 一致。
- `cortico.icon` 指向包内的 `.png` / `.webp` / `.svg`。
- `cortico.describe` 指向 `describe.json`,且和源码一致(`pnpm describe:extension` 会重写它)。**改过工具说明或 `ENV_PROMPT.md` 就要重新生成。**
- `cortico.tags` 用索引仓词表里的词;自动维护的标签作者声明无效。
- 没设 `os` 就是对所有平台列出。这个包跨平台,不用设。

向官方市场提申请:在 `Pal-AI-Lab/cortico-extensions` 开 issue,标题 `[<类型>] <包名>`,类型是 `certify` / `supersede` / `appeal` / `report` / `tags` / `new-tag` / `other`;正文每行一个 `key: value`(`package:` `add:` `remove:` `reason:` `evidence:`),用不上的键不写。
