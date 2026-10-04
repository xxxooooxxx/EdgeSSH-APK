# Cloudflare Zero Trust Access 配置

> 本页仅适用于 `AUTH_PROVIDER=cloudflare`。使用原生 `AUTH_PROVIDER=github` 时不需要 Zero Trust，按[部署指南](../DEPLOYMENT.md#github-模式准备)配置 GitHub OAuth App 即可。两种认证互斥，切换不会更改管理员主机资料。

> **普通部署无需手工执行本页步骤。** 启用 Zero Trust 后，保存 Cloudflare API Token，在 **Actions > Deploy > Run workflow** 输入管理员邮箱，工作流会自动创建/复用 Access 应用、邮箱 Allow 策略、OTP，并获取团队域与 AUD、保存 Worker Secrets。详见[自动部署指南](../DEPLOYMENT.md)。
>
> 本页保留控制台操作，供排障、维护既有应用或扩展 GitHub 等登录方式使用。部署脚本不会覆盖已有应用的 IdP 配置。

EdgeSSH **不提供本地用户名 / 密码登录**。为了避免任何人直接打开你的 WebSSH，生产环境必须把访问入口放在 Cloudflare Zero Trust Access 后面。

EdgeSSH 会在 Worker 内再次校验 Cloudflare Access 注入的 `Cf-Access-Jwt-Assertion`，包括签名、Issuer、Audience、有效期、用户 `sub` 和邮箱。因此，仅仅给域名加一个普通登录页还不够：**Access 应用、身份策略、`ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD` 必须对应同一个应用。**

> [!IMPORTANT]
> 本项目默认按**单管理员**设计。推荐使用“明确邮箱 + 允许（Allow）”策略。不要使用**所有人（Everyone）**、**绕过（Bypass）**，也不要只限制到整个邮箱域名。

## 推荐方案：指定邮箱 + 一次性 PIN（One-time PIN）

对于个人部署，最简单的方案是只允许你的邮箱，并使用 Cloudflare 的邮件验证码登录。

### 1. 启用一次性 PIN（One-time PIN，可选）

如果你已经配置 Google、GitHub、Microsoft Entra ID 等标识提供程序（Identity Provider），可以直接跳过这一步。

Cloudflare 新建的 Zero Trust 组织目前不会自动添加一次性 PIN（One-time PIN）。需要邮件验证码登录时：

1. 打开 Cloudflare 控制面板（Dashboard）。
2. 进入 **Zero Trust > 集成（Integrations）> 标识提供程序（Identity providers）**。
3. 在 **您的标识提供程序（Your identity providers）** 中选择 **添加新的标识提供程序（Add new identity provider）**。
4. 选择 **一次性 PIN（One-time PIN）** 并保存。

<img width="704" height="557" alt="image" src="https://github.com/user-attachments/assets/64d12f4d-4805-4b89-a46e-46f25dce1318" />


Cloudflare 官方说明：
https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/

### 2. 创建 Access 应用

1. 进入 **Zero Trust > 访问控制（Access controls）> 应用程序（Applications）**。
2. 选择 **创建新应用程序（Create new application）**。
3. 选择 **自托管和私有应用（Self-hosted and private）**。
4. 选择 **添加公共主机名（Add public hostname）**。
5. **应用程序名称（Application name）** 可填写 `EdgeSSH`。
6. **公共主机名（Public hostname）** 填写 EdgeSSH 实际使用的入口。默认可以直接使用 Worker 自带域名：

   ```text
   edgessh.<你的 Workers 子域>.workers.dev
   ```

   使用 Worker 自带域名时，GitHub Actions 中的 `CUSTOM_DOMAIN` 必须删除或留空，不要把 `*.workers.dev` 填进去。如果确实绑定了自定义域名，才填写例如 `ssh.example.com`。自定义域名不是部署必需项。

7. `workers.dev` 与自定义域名都可以作为正式入口，但必须在这里保护实际使用的 hostname。不要把另一个无关域名或未受保护的地址当作入口。

Cloudflare 官方说明：
https://developers.cloudflare.com/workers/configuration/cloudflare-access/

### 3. 添加身份访问策略

在应用的**访问策略（Access policies）**中创建一条策略：

| 项目 | 推荐值 |
| --- | --- |
| 策略名称（Policy name） | `EdgeSSH Admin` |
| 操作（Action） | `允许（Allow）` |
| 规则类型（Rule type） | `包括（Include）` |
| 选择器（Selector） | `电子邮件（Emails）` |
| 值（Value） | 你的完整邮箱，例如 `you@example.com` |

如果需要使用多个邮箱登录，请逐个添加明确邮箱。它们都是同一管理员工作区的获准身份，共用完整权限与同一份主机资料，不是独立用户。

> [!WARNING]
> 不要使用**包括（Include）> 所有人（Everyone）**。如果使用一次性 PIN（One-time PIN），也不要只写**包括（Include）> 登录方式（Login Methods）> 一次性 PIN（One-time PIN）**，否则任何能接收邮件验证码的人都可能符合策略。
>
> 本项目也不建议使用**电子邮件以 @example.com 结尾（Emails ending in @example.com）**这类整域授权，除非你明确希望该域下所有可验证用户都能进入 EdgeSSH。

Cloudflare Access 默认拒绝未匹配允许（Allow）策略的用户。

策略说明：
https://developers.cloudflare.com/cloudflare-one/access-controls/policies/

### 4. 选择登录方式并保存应用

在应用的**身份验证（Authentication）**设置中，选择你希望允许的**标识提供程序（Identity Provider）**。

个人部署通常可以只保留：

```text
一次性 PIN（One-time PIN）
```

如果只启用一个标识提供程序，也可以开启 Cloudflare 的**应用即时身份验证（Apply instant authentication）**，让用户直接进入对应登录流程。

保存应用后，先打开 EdgeSSH 的实际入口测试一次。正确情况下，无论入口是 `workers.dev` 还是自定义域名，浏览器都会先进入 Cloudflare Access 登录，再进入 EdgeSSH。

## 获取 EdgeSSH 需要的两个 Access 参数

### ACCESS_TEAM_DOMAIN

进入 Cloudflare Zero Trust 的**设置（Settings）**，找到**团队名称（Team name）/ 团队域（Team domain）**。

例如 Cloudflare 显示：
<img width="730" height="583" alt="image" src="https://github.com/user-attachments/assets/6f095c14-5880-42b4-8850-4fc3d9b74386" />


则输入：

```text
my-team.cloudflareaccess.com
```

> [!IMPORTANT]
> `ACCESS_TEAM_DOMAIN` **不要带** `https://`，不要带路径，也不要带末尾斜杠。

### ACCESS_AUD

1. 进入 **Zero Trust > 访问控制（Access controls）> 应用程序（Applications）**。
2. 找到刚才创建的 EdgeSSH 应用，选择**配置（Configure）**。
3. 在**其他设置（Additional settings）**中找到**应用受众 (AUD) 标签（Application Audience (AUD) Tag）**。
4. 复制完整值。

Cloudflare 官方获取 AUD 的说明：
https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/

## Worker 机密（Secret）的自动管理

自动部署会取得并保存以下值到 Cloudflare Worker Secrets，无需用户复制回 GitHub：

| 名称 | 示例值 | 说明 |
| --- | --- | --- |
| `ACCESS_TEAM_DOMAIN` | `my-team.cloudflareaccess.com` | 前面取得的团队域（Team Domain），不带协议和路径 |
| `ACCESS_AUD` | `012345…`（常见外观） | 前面取得的应用受众 (AUD) 标签（Application Audience (AUD) Tag），必须原样复制实际值 |
| `ENCRYPTION_KEY` | `AbCd…=`（44 字符 Base64） | 32 字节安全随机数的标准 Base64，只在首次部署时生成，后续始终复用；不要使用示例文本 |

`Deploy` 通过标准输入写入机密，后续保留 Worker 中的加密密钥。它们不会写入 `wrangler.toml`、临时文件、普通变量或提交记录。同为 Cloudflare 模式的普通重部署会实际确认入口仍受 Access 保护并保留已有 Team Domain/AUD；首次启用或从 GitHub 切回时才通过 Access API 核对应用与策略。部署不会仅凭旧 Secret 名称假定入口有效，也不会覆盖人工维护的 IdP 或明确身份策略。

`ENCRYPTION_KEY` 的生成要求和保管注意事项见[部署指南](../DEPLOYMENT.md#worker-runtime-secrets)。生产部署不需要在本地执行 Wrangler 机密（Secret）或 Worker 部署命令。

## 验证配置

部署完成后建议检查：

1. 未登录时访问实际入口，应先出现 Cloudflare Access，而不是直接进入 EdgeSSH。
2. 不在允许（Allow）策略中的邮箱不能进入。
3. 使用允许的邮箱登录后，可以正常加载主机列表和 `/api/auth/me`。
4. 直接访问未受 Access 保护的入口，不应能够操作主机或建立 SSH 会话。
5. 不要把 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、Access 令牌（Token）或登录 Cookie 提交到 Git 仓库。

## 常见问题

### 页面能打开，但 EdgeSSH 提示“管理员尚未配置 Zero Trust Access”

检查：

- Worker 中是否已有 `ACCESS_TEAM_DOMAIN` Secret，以及最近一次 `Deploy` 是否成功。首次部署请提供管理员邮箱，由工作流自动获取并保存。
- 团队域（Team Domain）是否为 `xxx.cloudflareaccess.com`，且没有 `https://`。
- Worker 中是否已有 `ACCESS_AUD` Secret，并对应当前入口的 Access 应用。更换 hostname 后需要带管理员邮箱重新运行部署。

### 登录后提示“Access 登录已失效”

常见原因：

- `ACCESS_AUD` 来自另一个 Access 应用。
- `ACCESS_TEAM_DOMAIN` 属于另一个 Zero Trust 组织。
- 你通过没有受对应 Access 应用保护的域名进入 Worker。

### 邮箱登录完成，但 EdgeSSH 仍显示“未认证”

1. 先确认浏览器地址栏与 Access 应用的公共主机名完全一致。`edgessh.<子域>.workers.dev` 和 `ssh.example.com` 是两个不同入口，登录 Cookie 不能跨 hostname 复用。
2. 使用 `workers.dev` 时删除或留空 `CUSTOM_DOMAIN`，然后重新部署。该变量只接受真正的自定义域名；新版部署校验会直接拒绝误填的 `*.workers.dev`。
3. 在同一个 hostname 直接打开 `/api/auth/me`。若仍返回 401，检查 `ACCESS_AUD` 是否来自保护该 hostname 的同一个 Access 应用，以及 `ACCESS_TEAM_DOMAIN` 是否属于同一个 Zero Trust 组织。
4. 确认最近一次 `Deploy` 工作流成功。登录令牌优先从 `Cf-Access-Jwt-Assertion` 请求头读取，并兼容同源浏览器的 `CF_Authorization` Cookie；二者都没有时，说明当前入口没有正确经过 Access。

### 一次性 PIN（One-time PIN）收不到邮件

先确认 Access 策略（Policy）中的**电子邮件（Emails）**与登录邮箱完全一致。

Cloudflare 对未被策略允许的邮箱不会发送验证码，但登录页面仍可能显示“验证码已发送”，以避免泄漏访问名单。邮件安全网关或链接扫描器也可能提前消耗验证码。

---

如果你已经有成熟的 Google / GitHub / Entra ID / Okta 等标识系统，可以继续使用现有标识提供程序（IdP）；EdgeSSH 并不要求一次性 PIN（One-time PIN）。关键要求只有两个：

- 用户必须先通过 Cloudflare Access 的身份认证与允许（Allow）策略。
- EdgeSSH 中配置的团队域（Team Domain）与 AUD 必须与这个 Access 应用一致。
