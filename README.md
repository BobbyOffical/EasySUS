# 🟩 EasySUS — Minecraft 服务器快速搭建助手

帮腐竹在 **Windows / Linux / macOS** 上通过一个简洁网页控制台快速搭建、管理 Minecraft 服务器。
纯 Node.js 实现，**零 npm 依赖**，装好 Node.js（≥16，建议 18+）即可运行。

## 功能一览

| 功能 | 说明 |
|---|---|
| 📊 状态总览 | 运行状态大圆点、在线玩家、TPS、运行时长、陶瓦/EasyTier 双额度槽位可视化 |
| ⬇️ 下载服务端 | Vanilla / Paper / Purpur / Fabric / Forge 一键下载，可切换下载源；被阻断的域名自动走内置中转 |
| ⚡ 下载修复 | Paper 已切换到 v3 API、Fabric 补全 installer 版本、Forge 修正 maven 路径；提供**按类型过滤的可用版本列表**避免选到不支持版本 |
| 🧩 模组下载 | 从 **Modrinth** 搜索并一键安装模组/插件/数据包到实例（按加载器+游戏版本精确匹配），支持查看已安装、禁用/启用、删除 |
| ☕ Java 环境 | 自动检测系统 Java，按 MC 版本推荐，一键下载 Temurin |
| 🖥️ 控制台 | 实时日志 + 命令输入，等价于服务器终端 |
| 🎨 界面颜色 | 6 套预设主题（深蓝/青草/深海/落日/紫晶/雪白）+ 12 项颜色逐项自定义，即改即生效并自动保存 |
| 🌍 自有公网 IP | 直接暴露端口，无人数限制 |
| 🏺 陶瓦联机 | **网页端一键下载安装 Terracotta**（Gitee/GitHub/CNB 三镜像），自动创建房间、显示房间码；内置**局域网广播**让专用服务端能被陶瓦发现；全局同时 **≤ 6** 个普通用户 |
| 🕸️ 远程访问 | EasyTier 组网**远程打开本控制面板**（手机/笔记本随时管理服务器），最多 **8 台设备**；自动生成网络名/密钥与远程面板地址 |
| 💜 贡献豁免 | 贡献者（认领捐赠令牌）**永久免除全部人数上限**且不占额度；页面顶部醒目横幅劝导 |
| 🌐 公网入口 | 玩家**免装软件、免房间号**，多人游戏里直接输 `地址:端口` 进服（内置公网服务器自动做端口转发） |
| 🔄 自动更新 | 侧边栏自动检查新版本；一键下载 → 重启应用；失败可回滚（旧文件自动备份到 `data/update-backup/`） |

## 快速开始（腐竹端）

```
Windows:   双击 start.bat（使用 EasyTier 需右键「以管理员身份运行」）
Linux:     sudo bash start.sh（EasyTier 创建虚拟网卡需要 root）
macOS:     双击 start.command
```

浏览器打开 **http://127.0.0.1:19388**：

1. 「下载服务端」→ 选类型（推荐 Paper）、下载源（国内推荐 BMCLAPI）、版本 → 下载
2. 「Java 环境」→ 确认/一键安装 Java
3. 「联机设置」→ 二选一：自有公网 IP / 陶瓦联机
   - 陶瓦：点「下载安装陶瓦联机」→「启动陶瓦」→「创建房间」→ 把房间码发给玩家
4. 「状态总览」→ 选实例 → ▶ 启动
5. （推荐）「联机设置 → 🌐 公网入口」→ 点「开启公网入口」→ 得到一个 `IP:端口` 地址，
   玩家**什么都不用装**，多人游戏里直接添加即可进服
6. （可选）「远程访问」→ 安装并启动 EasyTier → 在手机/其它设备加入同一组网，用显示的远程面板地址随时管理服务器 🕸️
7. 「界面颜色」→ 选你喜欢的主题 🎨

## 🌐 公网入口 —— 玩家免房间号直连

**目标**：玩家不用记房间码、不用装陶瓦/EasyTier，在 Minecraft「多人游戏」里直接添加
`地址:端口`（或你的域名）就能进服。

**原理**（全自动，腐竹只需点一个按钮）：

```
玩家 ──直连──> 公网服务器:30001 ══ EasyTier 端口转发 ══> 你的电脑(虚拟IP):25565 ──> MC 服务器
              （协调中心常驻节点，自动加入你的私有网）
```

1. 你的 EasySUS 用本机 EasyTier 建一个私有网（虚拟 IP 上跑着 MC）
2. 点「开启公网入口」→ 内置公网服务加入同一网络，把 `公网IP:随机端口` 转发到 `你的虚拟IP:MC端口`
3. 网页显示「玩家连接地址」，一键复制发群；30 秒心跳维持，服务器停止/关闭时自动释放端口
4. 停止后再开启会分配新端口（想固定请用域名 + SRV，见下）

| 项目 | 说明 |
|---|---|
| 前置条件 | ① MC 服务器已启动 ② 本机 EasyTier 已安装（远程访问页一键装）③ Windows 需管理员权限 |
| 额度 | 占用 1 个「远程访问」名额（≤8），贡献者豁免 |
| 域名玩法 | 买个域名后给 `play.你的域名` 加 **SRV 记录**（`_minecraft._tcp` → 目标=公网IP，端口=分配的端口），玩家只输 `play.你的域名` 即可。注意端口会变，需同步更新 SRV；若用固定端口（管理员在协调中心 config.json 预留）则一劳永逸 |
| 延迟 | 经公网服务器中转一跳；玩家与服务器都在国内时通常完全可玩 |

> ⚠️ 公网服务器需放行 **TCP/UDP 30000-30200**（腾讯云安全组 + 系统防火墙），否则玩家连不上。

## 联机服务（内置 · 不可见 · 不可改）

额度与公网入口由**内置的联机服务**统一仲裁。其地址：

- 以 **AES-256-GCM 密文**保存于 `client/secret.js`，密钥三段碎片独立存放于 `client/netkeys.js`
- **仓库任何文件中都没有明文**（grep 无果）；不写入用户机器 config.json；API 不返回；UI 不显示
- 请求修改会被忽略并强制还原；换地址/轮换密钥：`node tools/obfuscate.js --rotate "<新地址>" [--new-keys]`

规则：

- 陶瓦联机：普通用户同时 **≤ 6**
- EasyTier 远程访问 / 公网入口：同时 **≤ 8**
- 贡献者：豁免、不占额度
- 客户端开启联机前自动发送「请求人数+1」申请额度，30 秒心跳维持，掉线 90 秒自动释放

> 诚实说明：客户端最终必须能解密出地址，所以这属于**混淆防护**——挡住搜索、扒取与批量滥用，
> 防不住愿意完整调试本程序的人。真正的访问控制在服务端（白名单、限流、鉴权、管理员令牌）。

## ⚠️ 服务端下载：各类型端点与修复记录

长期以来只有原版能下载，其余类型全部失败。逐项排查后是**四个各自独立的真实原因**：

| 类型 | 原因 | 修复 |
|---|---|---|
| **Paper** | PaperMC **v2 API 已停用**，返回 `410 Gone` | 改用 **v3 API**（`fill.papermc.io/v3`），从 `downloads["server:default"]` 取地址，优先 STABLE 通道 |
| **Fabric** | server jar 端点需要**三段参数**（游戏版本 / loader / installer），少传 installer → `404` | 补全 installer 版本（`/v2/versions/installer`），并按该游戏版本挑选稳定 loader |
| **Forge** | maven 路径与文件名必须用**完整版本号** `{mc}-{forge}`，原代码少写 MC 版本且路径多了 `releases/` → `404` | 修正为 `maven.minecraftforge.net/net/minecraftforge/forge/{mc}-{forge}/forge-{mc}-{forge}-installer.jar` |
| **Purpur** | `purpurmc.org` 域名在国内被**针对性阻断**（HTTP/HTTPS 均失败，且 BMCLAPI 没有 Purpur 镜像） | 新增**受限下载中转**：直连失败自动改由联机服务代为下载 |

### 受限下载中转（`/api/relay`）

- 客户端直连失败 → 自动回退到内置联机服务中转，网页会显示「已通过联机服务中转」
- 服务端有**主机白名单**（仅限 Mojang/PaperMC/Purpur/Fabric/Forge/BMCLAPI/Modrinth 等官方下载域名）、**每 IP 每小时限流**、单文件 400MB 上限，不会被当成通用代理滥用
- 也可用 `EASYSUS_COORD_RELAY=0` 关闭

### 下载源适用性

| 下载源 | 适用类型 |
|---|---|
| 官方源 / 备用源 | 全部类型 |
| BMCLAPI / 国内镜像 | **原版**（版本清单与 jar）与 **Forge**（maven 镜像）；Paper/Fabric 无国内镜像，仍走官方 |

### 常见提示

- 版本下拉框现在**按类型列出真正可用的版本**（Fabric 列其支持的版本、Forge 列有构建的版本等），不会再选到不存在的版本
- **Forge 下载的是安装器**（`forge-{mc}-{forge}-installer.jar`），首次启动前需在实例目录运行一次：
  `java -jar forge-...-installer.jar --installServer`
- **Spigot** 需 BuildTools 自行编译，建议直接改用 Paper

## ⚠️ 为什么陶瓦「一直在扫描 MC 端口」？（已修复）

陶瓦开房时的「扫描 MC 端口」**并不是端口扫描**：它监听的是 Minecraft **局域网广播组播**
`224.0.2.60:4445`，解析数据包里的 `[MOTD]…[/MOTD][AD]端口[/AD]`（源码 `src/mc/scanning.rs`）。

单人存档「对局域网开放」会自动发这个包，所以启动器联机一切正常；
但**专用服务端（server.jar）永远不会发局域网广播** —— 于是陶瓦会永远卡在
「正在扫描本机 Minecraft 端口」。

**EasySUS 的修复**：点「创建房间」时，由 EasySUS 代替专用服务端周期性（1.5 秒）发出
同格式的局域网广播包，房间就绪后自动停止。因此：

1. 请先在「状态总览」**启动服务器**，再点「创建房间」（未启动会被拦下并提示）
2. 联机面板会实时显示「局域网广播 ● 广播中 :25565（已发 N 次）」
3. 房间码正常出现（实测 2 秒内进入 `host-ok`）

## 💜 捐赠令牌：提交 Issue 获取

1. 前往 EasySUS 的 **GitHub Issues** 提交 issue，标题「申请捐赠令牌」，说明你贡献的服务器情况
2. 管理员用 `admin-cli.js` 从令牌池取出令牌，回复在 issue 里
3. 用户在网页「贡献服务器」页填入令牌 → 立即成为贡献者

### 🕸️ 最容易的贡献方式：捐赠服务器至 EasyTier

网页「贡献服务器」页内置了完整图文教程（含一键复制命令），要点：

1. 准备一台有公网 IP 的服务器（1 核 1G 即可）
2. 解压 EasyTier 后**不带任何参数**执行 `./easytier-core` —— 这就已经是公共共享节点（无需 root、无需配置网络名/密钥）
3. 用 systemd 注册开机自启，**务必设置 `LimitNOFILE=1048576`**（公共节点 fd 消耗大，否则会耗尽而拒绝服务）
4. 放行 TCP/UDP 11010-11013 端口
5. 建议配置 **fail2ban** 自动封禁无效连接（教程内附 filter/jail 配置）
6. 进阶：`--relay-network-whitelist --relay-all-peer-rpc`（只帮打洞不转发流量）、`--private-mode true`（只服务自己的网络）

完成上述任一种贡献后，提交 issue 登记即可领取捐赠令牌。

### 管理员命令行工具（admin-cli.js）

令牌池由协调中心**自动生成并维持 5 个待认领令牌**，你只需取出发给用户：

```
node admin-cli.js status                    # 查看双额度状态
node admin-cli.js take --note "issue #12"   # 取一个新令牌（命令行直接返回给你）
node admin-cli.js list                      # 全部令牌（池中/已取出/已认领）
node admin-cli.js sessions                  # 当前活跃会话
node admin-cli.js grant --token XXX         # 手动造指定令牌
node admin-cli.js mark <userId> [--off]     # 直接标记/取消贡献者
```

管理员令牌保存在本机 `admin-token.local`（已 gitignore），也可用环境变量 `EASYSUS_ADMIN_TOKEN`。

## 目录结构

```
EasySUS/
├── start.bat / start.sh / start.command   # 三端启动脚本
├── admin-cli.js           # 管理员命令行（取令牌发给 issue 用户）
├── admin-token.local      # 管理员令牌（不入库）
├── client/                # 腐竹本机控制台
│   ├── server.js          # Web 服务与 API 路由
│   ├── config.js          # 配置（含主题、EasyTier 网络；联机服务地址强制内置）
│   ├── secret.js          # 内置联机服务地址（AES-256-GCM 密文，不落盘/不外露）
│   ├── netkeys.js         # 密钥碎片（与密文分离；发布前用 tools/obfuscate.js 轮换）
│   ├── gateway.js         # 公网入口客户端（免房间号直连：开/心跳/关）
│   ├── updater.js         # 自动更新（检查/下载/暂存/应用）
│   ├── unzip.js           # 零依赖 zip 解压（更新包用）
│   ├── lanbroadcast.js    # 局域网广播：让陶瓦能发现专用服务端
│   ├── mcserver.js        # MC 进程管理
│   ├── download.js        # 服务端下载（多类型、多下载源）
│   ├── mods.js            # 模组/插件下载安装（Modrinth API）
│   ├── java.js            # Java 检测与一键安装
│   ├── quota.js           # 协调中心配额客户端（taowa/easytier 双模式）
│   ├── terracotta.js      # 陶瓦联机集成（下载/启动/房间 HTTP API）
│   ├── easytier.js        # EasyTier 组网（下载/启动/远程面板地址）
│   ├── web/index.html     # 网页前端（含主题系统）
│   └── data/              # 运行时数据
├── tools/
│   ├── obfuscate.js       # 发布前加密/轮换协调中心地址（AES-256-GCM）
│   └── apply-update.js    # 自动更新应用器（分离进程：换文件→重启）
└── coordinator/           # 联机服务端（管理员部署，客户端对其地址加密内置）
    └── server.js          # 双模式配额 + 令牌池自动生成 + 下载中转 + 公网入口网关
```

## 部署联机服务端（仅管理员）

> 客户端内的地址是加密内置的；更换服务端需同步改 `client/secret.js` 里的混淆常量。

```bash
cd coordinator
EASYSUS_COORD_ADMIN_TOKEN=你的口令 node server.js   # 默认 127.0.0.1:19400
```

生产部署建议配 systemd + nginx 反代（参考 `/coord/` 前缀路由，server.js 原生支持前缀）。

### Coordinator API

| 接口 | 说明 |
|---|---|
| `GET /api/status` | 公共状态（taowa/easytier 双额度） |
| `POST /api/session/request` | 申请额度 `{userId, mode: taowa\|easytier, requestedSlots(=人数+1)}` |
| `POST /api/session/heartbeat` / `release` | 心跳 / 释放 |
| `POST /api/contributions/claim` | 认领捐赠令牌 |
| `POST /api/gateway/open` / `heartbeat` / `close` | 公网入口：开启（返回玩家地址）/ 心跳 / 关闭回收 |
| `GET /api/gateway/status?userId=` | 公网入口状态 |
| `GET /api/relay?url=` | 受限下载中转（主机白名单 + 限流） |
| `POST /api/admin/contributions/take` | 从池中取令牌（管理员） |
| `GET /api/admin/overview` | 总览（管理员） |

## 注意事项

- **EasyTier 需要管理员/root 权限**创建虚拟网卡；无权限时自动尝试 `--use-smoltcp` 用户态回退。
- 陶瓦房间创建前需 MC 服务器已启动（Terracotta 会扫描本机端口）。
- Terracotta © burningtnt，AGPL-3.0；EasySUS 通过其官方 HTTP API 以独立进程集成，符合其许可例外条款，界面已标注版权。
- Forge 下载的是 installer，需在实例目录运行一次安装（后续版本计划自动化）。
- 下载源受网络影响：BMCLAPI/Gitee 适合中国大陆，官方源适合海外。

## License

MIT（第三方组件遵循各自许可）
