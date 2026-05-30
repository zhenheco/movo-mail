# Movo Mail — `@movo.com.my` 發信網域 + CF-native Webmail 設計

- **日期**: 2026-05-30（v2：改用 cf-email/MailChannels，撤 Resend）
- **狀態**: 設計認可，build 中
- **repo**: `zhenheco/movo-mail`（**public**，secret 全 CF Secret Store + 1P，gitleaks 每 commit 擋）
- **CF 帳號**: movo.com.my 等 28 zone 在 `acejou27@gmail.com` CF account（`f9916b95…`，global key 在 1P `CLOUDFLARE_GLOBAL_KEY`）→ DNS / Email Routing / Workers 全可自接

---

## 1. 背景

`movo.com.my` 要成正規發信網域、多人（1-5）共用。現況：CF Email Routing 收信、SPF 只授權 CF、`DMARC p=reject`、Brevo 半設、WP 在發 KYC 信（`p=reject` 下無對齊認證 → deliverability 很可能壞）。

需求：① 系統交易信（WP/Dokan） ② 人的信箱 + AI 代寫代發客戶信 ③ 行銷群發（defer Phase 5）。

人信箱方案：**Choice C — CF-native 自建 webmail**（無 turnkey repo，須 build）。

---

## 2. 發信引擎：全走既有 cf-email Worker（MailChannels），不接 Resend

zhenheco 已有中央交易郵件中繼 **cf-email Worker**（`https://cf-email.acejou27.workers.dev`），底層 = **Cloudflare Email Routing `send_email` binding**（非 MailChannels、非 Resend）。本專案所有出站信都打它，符合全域 `cf-email-sdk` 標準（idempotency / suppression / webhook / D1 log 集中）。

- `POST /send`，header `X-API-Key: cfes_…`（env 名 `CF_EMAIL_API_KEY`），body `{ to, from, subject, html, text, tags? }` + `Idempotency-Key` header。`tags` 是 `string[]`。
- **本 repo 零 ESP/寄信 key**（認證集中在 cf-email Worker）。
- ⚠️ **cf-email 現況硬限制**（見 cf-email-sdk skill）：(a) **不支援 attachments**；(b) **不支援 custom headers** → 無法帶 `In-Reply-To`/`References`，**outbound threading 無法原生串**；(c) **1000 封/天/domain**（CF Email beta 硬限）；(d) `to` 限單一純 email、`from` display name 會被剝。→ 見 §11 決策。

---

## 3. 架構：3 streams（subdomain 隔離 reputation）

| Stream | 路徑 | From | 本 spec |
|---|---|---|---|
| 1 交易信 | WP `wp_mail()` → cf-email Worker → MailChannels | `no-reply@movo.com.my` | ✅ Phase 0 |
| 2 人信箱+AI | 收: CF Routing→Email Worker→D1/R2→webmail；寄: webmail/AI→cf-email Worker | `name@movo.com.my` | ✅ Phase 1-4 |
| 3 行銷群發 | 獨立工具（Listmonk 自架 / Brevo） | `news@news.movo.com.my` | ⏸ defer Phase 5 |

---

## 4. DNS / 認證地基（movo.com.my 在我們 CF，全可 API 設）

movo.com.my 在我們 CF（acejou27 帳號，Email Routing 已啟用 = 現有 MX）。cf-email 用 CF Email Routing `send_email`，**SPF 現況已足夠**。

- **保留** root MX = CF Email Routing（Stream 2 收信）。
- **SPF**：`v=spf1 include:_spf.mx.cloudflare.net ~all` 已涵蓋 CF 寄出，**不需改**。
- **DKIM**：CF Email Routing 自管（須確認 movo.com.my 在 cf-email Worker 所屬帳號已加為『可發送 / verified』domain；同 acejou27 帳號應可直接加白）。
- **DMARC** 維持 `p=reject`（CF 簽 DKIM 對齊即過）；過渡可先 `p=quarantine` + `rua` 觀察 1-2 週。
- **不需** MailChannels / Resend 任何 DNS 記錄（v1 草稿寫錯，撤回）。
- 清理：`brevo-code` TXT 若 Brevo 只作 Phase 5 行銷則暫留，否則刪。
- 驗證：寄 Gmail 看 `dkim=pass dmarc=pass` + mail-tester。

---

## 5. Stream 1：交易信（WP → cf-email Worker）

- mu-plugin `movo-mail-relay.php`：覆寫 `wp_mail()` → POST cf-email Worker（API key + idempotencyKey）。
- From `no-reply@movo.com.my`；整併既有 `movo-kyc-email.php` 直發邏輯，避免雙路徑。
- 驗收：KYC / 訂單信到外部 Gmail `dmarc=pass`、進 inbox。

---

## 6. Stream 2：Choice C — CF-native Webmail（新 repo `movo-mail`，部署在我們 CF 帳號）

### 6.1 Inbound
- CF Email Routing catch-all（`*@movo.com.my`）→ Email Worker `inbound`（**先讀現有 routing rules，勿覆蓋現行轉發**）。
- `postal-mime` 解析 → 原始 `.eml` → R2（`msg/{id}.eml`）、附件 → R2（`att/{id}/{n}`）、index → D1。

### 6.2 Data model（D1）
- `users(id, email, name, role, created_at)`
- `mailboxes(id, address, user_id)`
- `threads(id, mailbox_id, subject, last_at)`
- `messages(id, thread_id, message_id, in_reply_to, ref_ids, from_addr, to_addrs, cc_addrs, subject, date, direction['in'|'out'], r2_key, snippet, seen, has_attachment)`
- `attachments(id, message_id, filename, mime, size, r2_key)`
- `send_log(id, message_id, cfemail_id, status, created_at)`
- `audit_log(id, user_id, action, target, created_at)`
- suppression：以 cf-email Worker 的 KV 為準（送出被擋即回報），webmail 不另存。

### 6.3 Webmail UI
- 單 Worker（Hono）+ React(Vite)+Tailwind+shadcn，靜態走 Workers Assets，**behind CF Access**（≤50 免費，Google/OTP）。
- Views：inbox list / thread / compose / search。HTML mail 顯示 sanitize（DOMPurify）防 XSS。

### 6.4 Outbound / Send
- `POST /api/send` → 驗證 → call **cf-email Worker `/send`**（From `name@movo.com.my`、`In-Reply-To`/`References`、idempotencyKey）→ 成功寫 `messages(direction=out)` + `send_log` + R2 `.eml`。

### 6.5 AI 代寫代發
- `POST /api/ai/draft` → LLM 依 thread context 起草 → 回 draft。**Phase 4 先強制人工核可** → `/api/send`。
- Guardrail：per-mailbox rate-limit、僅 1:1（禁 bulk）、寫 `audit_log`。

### 6.6 Bounce / complaint
- 集中在 cf-email Worker（MailChannels webhook）。webmail 經 cf-email `/status/:id` 更新 `send_log`。

---

## 7. 部署 / CI

- 新 public repo `zhenheco/movo-mail`，與 WP repo 完全解耦，部署在 **acejou27 CF 帳號**（movo.com.my 所在）。
- **GitHub = 版控 SSOT**；GitHub Actions：`npm ci`→typecheck→test→ `main`：`wrangler deploy --env staging` → tag/manual approve：`--env production`。public repo = GitHub Actions 分鐘無限。
- `wrangler.toml` 多 env：staging / production 各自 D1 / R2 / KV。
- D1 migrations 進 pipeline。
- **deploy 授權**：現 wrangler OAuth 為 read-only（缺 Workers:Edit / email_routing:write / email_sending:write）。需 `wrangler login` refresh，或 CI 用 scoped API token（Workers Scripts / D1 / R2 / KV / Zone DNS / Email Routing Edit）。本機可暫用 global key（`CLOUDFLARE_API_KEY`+`CLOUDFLARE_EMAIL`）。
- Secrets：CF Secret Store；GitHub Actions secret 僅 scoped CF token。**repo 零 secret**（public）。

---

## 8. Security

- 全 behind CF Access；per-mailbox 權限隔離。
- repo **public → secret 衛生零失誤**：`.gitignore`（`.dev.vars`/`.env`/`*.key`/`*.pem`）、gitleaks 每 commit、CI secret 掃描。
- email body 顯示 sanitize（DOMPurify）。
- AI send：audit log + rate-limit + suppression。
- cf-email Worker API key 僅 CF Secret Store。

---

## 9. Testing（TDD）

- inbound parse：sample `.eml` → assert D1 rows + R2 keys。
- send：mock cf-email `/send` → assert from / In-Reply-To / idempotencyKey、suppression 攔截、`send_log`。
- auth：未登入 → 401。
- threading：reply 串回同 thread。
- AI draft：mock LLM → 回 draft、未核可不寄。
- DNS/DMARC：手動 gate（mail-tester / MXToolbox / Gmail Authentication-Results）。

---

## 10. Phases

| Phase | 內容 | 阻擋於 |
|---|---|---|
| **P0** | DNS（SPF+lockdown+DKIM）+ movo.com.my 在 cf-email/MailChannels 驗證 + WP relay | MailChannels 帳號方案確認 |
| **P1** | inbound capture → D1/R2 | — |
| **P2** | webmail read UI + CF Access | — |
| **P3** | compose/send（cf-email）+ threading | cf-email custom headers 支援確認 |
| **P4** | AI 代寫代發 + guardrail | LLM key |
| P5 | 行銷群發 | 另 spec defer |

---

## 11. Open questions

- **【重要決策】cf-email 限制怎麼處理**：cf-email 現**不支援 attachments + custom headers(In-Reply-To)**。
  - **選項 A（v1 快速上線）**：接受限制 — webmail 可寄純文字/HTML，**不能寄附件**、**回信不串原 thread**（收件端視為新信）。AI 代寫代發純文字客服信 OK。
  - **選項 B（擴充中央服務）**：去 `Waiting projects/cf email` repo 擴 `/send` 支援 `attachments`(base64) + `headers`(In-Reply-To/References) + 擴 `email_logs` schema + SDK。一次做全品牌受惠，但動到中央 transactional 服務、要 TDD + 不可破壞現有 caller。
  - 建議：**v1 走 A 先上線**，B 排後續 milestone。 → ✅ **已選 A（2026-05-30）**：webmail v1 寄純文字/HTML、無附件、回信不串 thread；附件 + threading 留 B（擴中央 cf-email）排後續。
- movo.com.my 是否已在 cf-email Worker 帳號設為『可發送 domain』？（同 acejou27 帳號，須確認/加白）
- DMARC 過渡先 quarantine？（建議 yes）
- AI 代發 Phase 4 是否永久強制人工核可。
- webmail 自訂網域：`mail.movo.com.my`（Worker route，zone 我們的）。

---

## 12. Out of scope

行銷群發系統、對外 IMAP/SMTP 協定、自架 mail server、行動 app、calendar/contacts。
