# 共用信箱 — 跨 issue reconciliation notes（每個 implementer 必讀）

規劃階段並行 5 個 plan 時揪出的跨 issue 缺口與全域事實。實作任一 issue 前先讀本檔，再讀該 issue 的 NN-plan.md。

## 全域事實（所有 issue 適用）

1. **測試位置**：測試在 repo 根的 `/test/`，**不是** `src/` 同層。風格：
   - `test/db.test.ts` — 真 SQL（`node:sqlite`）載入 migration 跑 db 層。
   - `test/send.test.ts`、`test/api-read.test.ts`、`test/api-admin.test.ts` — mock `../src/db`，掛 route。
   - `test/inbound.test.ts` — inbound 回歸。
2. **migration 載入**：`test/db.test.ts` 的 `migrationSql()` 目前只載 `0001_init.sql`。任何需要 `kind`/`role`/`assignee_id` 欄位的測試，**必須**擴充它依序套用 `0002`（role）與新 `0004`（kind + assignee_id）。
3. **身分（load-bearing）**：`threads.assignee_id` 存的是 **`users.id`**（經 `getUserByEmail(env, user.email)` 解析），**不是** `AccessUser.sub`。所有「assignee = 我」比較、claim 寫入、可見性查詢，都要對 DB `users.id` 比，否則靜默 under-fetch / 比不中。
4. **`getMailboxesForUser` 不可改契約**：它必須維持「只回個人 owned 信箱」（登入閘門 + 個人讀取範圍依賴它）。共用信箱另走 `getSendableMailboxes` / 可見性查詢。

## 跨 issue 缺口（明確指派）

### A. `kind` 要進 mailbox DTO（issue 01 收尾 / issue 02）
- 加 `kind` 到 `Mailbox` type 與所有 mailbox SELECT（`getMailboxByAddress` / `getMailboxesForUser` / `listAllMailboxes`），否則讀出來 `kind: undefined`。
- `/api/mailboxes` 回應要帶 `kind`（前端 badge 依賴）。

### B. sendable HTTP route（issue 02 必補，超出原 plan）
- spec 只定 db 層 `getSendableMailboxes`，**沒定 HTTP route**。但前端 Compose 寄件選單（issue 05）需要一個端點拿到「owned 個人 ∪ 全部共用」清單（含 `kind`）。
- issue 02 **必須**新增 HTTP route 暴露 sendable 集合。建議 `GET /api/mailboxes/sendable`（或在既有 mailbox-list 端點加參數）。回應每筆含 `id`、`address`、`display_name`、`kind`。
- `GET /api/mailboxes` 目前只回個人信箱 — 不要改它的個人語意；用新 route 給 from-list。

### C. `assignee_id` 要進 Thread DTO（issue 04）
- thread 列表 / 單一 thread 回應要帶 `assignee_id`（前端標「未認領」依賴）。
- 同步加到 `web/src/lib/types.ts` 的 `Thread`。

### D. createMailbox welcome-email guard（issue 01）
- 建立 ownerless 共用信箱時，`sendWelcomeEmail` 沒有收件人 — 必須 `if (input.ownerEmail)` 包起來，否則失敗或誤報。

## 實作順序與依賴
01（schema + admin + kind DTO + welcome guard）→ 02（getSendableMailboxes + send 權限 + 新對話 assignee + sendable route + kind DTO）→ 03（inbound assignee 初值 + claimThread，claim 觸發在 send 路徑）→ 04（可見性 + 統一收件匣 + assignee_id DTO + IDOR 防護）→ 05（前端 fromOptions + 共用 badge + 未認領狀態）。

每步 TDD：先寫失敗測試 → 確認紅 → 最小實作 → 綠 → 重構。只測外部行為。改動全鏈同步（DB→service→API→前端）。
