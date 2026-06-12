# Plan 05 — 前端：寄件選單 + 共用標記 + 未認領狀態

> Issue: `.scratch/shared-mailboxes/issues/05-frontend-compose-and-shared-badges.md`
> Spec: `docs/superpowers/specs/2026-06-12-shared-mailboxes-design.md` (Slice 5, HITL)
> Type: feat · Blocked by: Issue 02 (sendable set), Issue 04 (visibility / unclaimed)

---

## 1. Context

讓共用信箱在前端可被選為寄件地址、與個人信箱視覺可區分、並標示未認領狀態。三件事：

- **Compose `fromOptions` 含全部共用信箱** — 不只自己擁有的個人信箱。資料來自後端 sendable 集合（`getSendableMailboxes` = owned 個人 ∪ 全部共用，Issue 02）。
- **共用信箱顯示「共用」badge** — Compose 寄件選單 + ThreadList 信箱清單/切換器，與個人信箱一眼可分。
- **收件匣標示未認領** — 對「未認領（assignee=NULL）」的共用對話顯示可辨識狀態（公海待領、非私有）。

**關鍵發現（跨 issue / DTO 依賴）：**

1. **`kind` 完全不存在於後端**：grep `src` + `migrations` 對 `kind` 0 命中。Badge 依賴 `mailbox.kind`，所以這份 plan **必須**包含後端最小新增——把 `kind` 加進 `GET /api/mailboxes` 回應 DTO（見 §2）。注意 migration 0004 已在 Slice 1 加 `mailboxes.kind` 欄位；本 plan 只負責「把欄位透出到 client」，不是重複加欄位。
2. **`GET /api/mailboxes` 目前只回個人信箱**（`getMailboxesForUser` JOIN owner_id，Spec §安全：登入閘門不可被共用污染）。Compose 的 `fromOptions` 目前 = App 的 `boxes` = `fetchMailboxes()` = **只有個人信箱**。要讓共用信箱進 `fromOptions`，前端需要一個**新的 sendable 端點**（後端 Issue 02 應提供 `getSendableMailboxes`），不能改 `/mailboxes`（否則污染登入閘門 `access.ts` 的 owns≥1 判斷與 inbox 切換器）。**這是對 Issue 02 的硬依賴**——若 02 未提供 sendable 端點，本 plan 阻塞（見 §2 標註）。
3. **`Thread` DTO 無 `assignee_id`**：`getThreads` / `getThreadsForOwner` 的 SELECT 與 `web/src/lib/types.ts` 的 `Thread` 都沒有 assignee。未認領 badge 依賴它，需後端在 thread 查詢透出 `assignee_id`（屬 Issue 04 範疇；本 plan 標為依賴並在前端型別補欄位）。

---

## 2. Files to touch

### 前端（本 plan 主體）

| 路徑 | 一句變更 |
|---|---|
| `web/src/lib/api.ts` | `MailboxSummary` 加 `kind: "personal" \| "shared"`；新增 `fetchSendableMailboxes()` 打 sendable 端點（含共用）；mailbox-summary 解析帶 `kind` |
| `web/src/lib/types.ts` | `Thread` 介面加 `assignee_id: string \| null`（mirror 後端透出欄位） |
| `web/src/components/ui/badge.tsx` | **新建**：小型 `<Badge>`（「共用」用 `variant="shared"`、未認領用 `variant="unclaimed"`），對齊既有 ui/ 元件風格（cn + variant，仿 button.tsx） |
| `web/src/components/Compose.tsx` | 寄件選單 `<option>` 對 `kind==="shared"` 加「（共用）」後綴；`fromOptions` 來源改用 sendable 集合（見 App.tsx）；`canPickFrom` 邏輯不動 |
| `web/src/components/MailboxSwitcher.tsx` | 切換器 `<option>` label 對共用信箱加「（共用）」後綴（native `<option>` 不能放 React node，用文字後綴） |
| `web/src/components/ThreadList.tsx` | `ThreadRow` 對未認領共用對話渲染「未認領」badge；接收 `mailboxes` 以判斷 thread 來源信箱是否 shared |
| `web/src/App.tsx` | 區分兩個來源：`boxes`（個人，驅動 inbox/switcher/登入閘門，維持 `fetchMailboxes`）vs `sendableBoxes`（含共用，驅動 Compose `fromOptions`，用 `fetchSendableMailboxes`）；傳 `sendableBoxes` 給 `<Compose fromOptions>` |

### 後端（最小 DTO 透出 — 本 plan 必要前置，因 badge 依賴）

| 路徑 | 一句變更 |
|---|---|
| `src/api/mailboxes.ts` | row→wire 映射加 `kind: m.kind`（`GET /api/mailboxes` 回 `kind`）；**前提**：`Mailbox` 型別 + `getMailboxesForUser` SELECT 已含 `m.kind`（Slice 1 migration 0004 已加欄位，需確認 SELECT 有撈） |
| `src/types.ts` | `Thread` 介面加 `assignee_id: string \| null`（若 Issue 04 未做則本 plan 補；前端 mirror 對齊） |
| `src/db/index.ts` | `getThreads` / `getThreadsForOwner` 的 SELECT 加 `t.assignee_id`（**屬 Issue 04**；若 04 已透出則跳過，僅驗證） |

> **sendable 端點（Issue 02 依賴）**：前端 `fetchSendableMailboxes()` 預期打一個回「owned 個人 ∪ 全部共用」且每筆帶 `kind` 的端點。Spec 列 `getSendableMailboxes(env,user)` 為 db 層介面但**未指定 HTTP 端點**。**Cross-issue 待確認**：Issue 02 是否暴露 `GET /api/mailboxes/sendable`（或 `?scope=sendable`）。若 02 僅做 db 層、未開端點，本 plan 需先補一個薄端點（`src/api/mailboxes.ts` 加 `GET /mailboxes/sendable` 呼叫 `getSendableMailboxes`），並在 §5 標為 step 0。

---

## 3. Acceptance criteria（copy from issue）

- [ ] Compose `fromOptions` 列出全部共用信箱，可選並成功寄出
- [ ] 共用信箱在選單與清單有「共用」標記，與個人信箱可區分
- [ ] 未認領共用對話在收件匣有可辨識狀態提示
- [ ] 視覺符合既有設計系統（字體/行高/間距）
- [ ] 既有 Compose / 收件匣行為無回歸

---

## 4. Test / verification plan

**Web 測試框架存在** ✅ — vitest，config 在 `web/vitest.config.ts`（`environment: "node"`，`include: web/src/**/*.test.{ts,tsx}`，`globals: true`）。執行：`npx vitest run --config web/vitest.config.ts`。

**Prior art（既有 web 元件測試風格）：**
- `web/src/components/MailboxSwitcher.test.tsx` — 用 `renderToStaticMarkup`（react-dom/server）渲染成 HTML 字串，再 `expect(html).toContain(...)` / `.toMatch(/regex/)` 斷言。**無 DOM、無 testing-library、無 user event**（node 環境）。
- `web/src/components/AdminPanel.test.tsx`、`web/src/lib/*.test.ts` 同風格。
- ⚠️ 因為是 `renderToStaticMarkup`，**只能測靜態渲染輸出**（哪些文字/class/option 出現），**不能測互動**（select onChange、send 點擊）。互動行為走手動視覺驗證。

### 自動測試（TDD，照 prior art 風格）

1. **`web/src/components/Compose.test.tsx`（新建）**
   - given `fromOptions` 含一個 `kind:"shared"` + 一個 `kind:"personal"`、非 reply、`canPickFrom` 成立 → render HTML 含共用信箱 address 且該 option 帶「（共用）」後綴；個人信箱 option 無後綴。
   - given 只有個人信箱 → 無「（共用）」字樣（無回歸）。
2. **`web/src/components/MailboxSwitcher.test.tsx`（擴充）**
   - 既有兩案保留；新增：`kind:"shared"` 的 option label 含「（共用）」；個人信箱不含。
3. **`web/src/components/ThreadList.test.tsx`（新建，若 renderToStaticMarkup 可渲染 useAsync 初始態）**
   - ThreadRow 對「shared 信箱 + assignee_id=null」的 thread → HTML 含「未認領」badge 文字；對 assignee 非空 / 個人信箱 thread → 不含。
   - ⚠️ ThreadList 依賴 `useAsync` 觸發 fetch；若靜態渲染卡在 loading 態無法斷言 row，**改為抽純函式**：把「該不該顯示未認領 badge」抽成 `web/src/lib/mailbox.ts`（或新 `lib/threadBadge.ts`）的純函式 `isUnclaimedShared(thread, mailboxesById)`，對純函式寫 `*.test.ts`（node、無渲染）。這是既有 codebase 偏好（lib/ 大量純函式 + 純函式測試，如 `mailbox.test.ts` / `selection.test.ts`）。**優先採此法**。
4. **`web/src/lib/api.test.ts`（擴充）** — `MailboxSummary` 解析含 `kind`；`fetchSendableMailboxes` 走既有 fetch mock 風格（對齊現有 api.test.ts）。

### 手動視覺驗證（HITL — Slice 5 type=HITL，互動 + 視覺需人眼）

前置：02/04 後端已 deploy 到 test 環境、test DB 已 `wrangler d1 migrations apply` 0004、且有 ≥1 共用信箱 + ≥1 未認領共用 thread 的種子資料。

1. **Compose fromOptions**：以 Kee（有個人信箱）登入 → 點「撰寫」→ 開 From 下拉 → **看到** `Hello@`/`Customer@`/`Service@`（共用）與 `Kee@`（個人）；共用 option 有「（共用）」後綴。
2. **寄出**：選 `Service@` → 填 to/subject/body → 點 Send → **成功**（無 403、`sendPhase==="sent"`、出現 "Message sent."）。
3. **共用 badge 區分**：From 下拉與（若多信箱）MailboxSwitcher 中，共用信箱與個人信箱**一眼可分**（後綴/badge）。
4. **未認領狀態**：切到 All mailboxes / 共用信箱 → 收件匣中未認領共用對話**有可辨識 badge**（「未認領」），已認領 / 個人對話**無**。
5. **無回歸**：純個人信箱使用者（單一信箱）→ From 行為不變（無 picker、無共用字樣）；個人對話列表無未認領 badge；既有 reply 鎖定 thread 信箱行為不變。
6. **CJK 視覺**：badge 與後綴文字繼承 body `line-height: 1.7` + CJK 字型堆疊，不破版、不擠壓 row 高度。

---

## 5. Implementation steps（ordered）

> **有測試框架 → 走 TDD（red→green→refactor）**；互動/視覺部分（select、send、實際渲染）無法用 `renderToStaticMarkup` 測，這些走小心增量編輯 + §4 手動驗證。

**Step 0 — 確認跨 issue 依賴（先做，否則阻塞）**
- 驗證 Issue 02 是否提供 sendable HTTP 端點（含共用 + `kind`）。若無 → 補薄端點 `GET /api/mailboxes/sendable`（`src/api/mailboxes.ts`，呼叫 `getSendableMailboxes`，映射含 `kind`）。
- 驗證 Issue 04 是否在 thread 查詢透出 `assignee_id`。若無 → 在 `getThreads`/`getThreadsForOwner` SELECT 加 `t.assignee_id` + `src/types.ts` `Thread` 加欄位。
- 確認 migration 0004 的 `mailboxes.kind` 已在 `getMailboxesForUser` SELECT 撈出（目前 SELECT 在 `src/db/index.ts:416` 沒有 `m.kind`，需加）。

**Step 1 — 後端 DTO 透出 `kind`（red→green）**
- 加（若缺）`src/api/mailboxes.test.ts` 或既有 worker 測試斷言 `GET /api/mailboxes` 每筆含 `kind`（red）。
- `src/db/index.ts` `getMailboxesForUser` SELECT 加 `m.kind`；`src/api/mailboxes.ts` 映射加 `kind: m.kind ?? "personal"`（green，`?? personal` 防 0004 未 apply 時 null）。
- worker 測試用 `npm run test:workers`（`vitest.workers.config.ts`）。

**Step 2 — 前端型別（red→green）**
- `web/src/lib/api.ts`：`MailboxSummary` 加 `kind: "personal" | "shared"`；`fetchMailboxes` 解析帶 `kind`；新增 `fetchSendableMailboxes()`（打 Step 0 確認的 sendable 端點）。
- `web/src/lib/types.ts`：`Thread` 加 `assignee_id: string | null`。
- 抽純函式 `isUnclaimedShared(thread, mailboxesById)` 進 `web/src/lib/mailbox.ts`；先寫 `mailbox.test.ts` 失敗案（red）→ 實作（green）。

**Step 3 — Badge 元件（green-first，純展示無分支邏輯）**
- 新建 `web/src/components/ui/badge.tsx`：仿 `button.tsx` 的 cn + variant 結構，`variant: "shared" | "unclaimed"`。
  - `shared`：低調但可辨識——`rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground`（沿用 ThreadList 既有 source-chip 樣式），文字「共用」。可選用 `--brand-gold`/`--brand-orange` token 做邊框/底色強化區分。
  - `unclaimed`：glanceable——較高對比，如 `text-[10px] font-medium` + 暖色（`--brand-orange`）outline 或底，文字「未認領」。

**Step 4 — Compose 寄件選單（增量 + 測試 + 手動）**
- 寫 `Compose.test.tsx`（red）：shared option 帶「（共用）」後綴。
- `Compose.tsx` option label：`kind==="shared" ? \`${label}（共用）\` : label`（green）。原生 `<select>` 內不能塞 React 元件，故用文字後綴。
- App 把 `sendableBoxes` 傳給 `<Compose fromOptions>`（見 Step 6）。

**Step 5 — MailboxSwitcher + ThreadList badge（增量 + 測試）**
- `MailboxSwitcher.tsx`：`optionLabel` 對 `kind==="shared"` 加「（共用）」後綴；擴充既有 test（red→green）。
- `ThreadList.tsx`：`ThreadRow` 用 `isUnclaimedShared(thread, mailboxesById)`（純函式已測）→ 為真時在 row 內渲染 `<Badge variant="unclaimed">`。把 `mailboxes`（含 kind）建成 `byId` map 傳入。源信箱 shared 與否由 `thread.mailbox_id` 對照 `mailboxes`。

**Step 6 — App.tsx 雙來源接線（增量 + 手動）**
- `boxes`（個人，`fetchMailboxes`）：續驅動 inbox / MailboxSwitcher / 登入閘門 / `composeMailboxId` 預設。**不可**用 sendable 取代（避免污染 owns≥1 與 switcher）。
- 新 state `sendableBoxes`（`fetchSendableMailboxes`）：驅動 `<Compose fromOptions={sendableBoxes}>`。fetch 失敗則 fallback 成 `boxes`（degrade，不阻塞寄信）。
- `fromOptions[0]` 預設仍應落在個人信箱：sendable 端點排序個人優先，或前端排序 personal 在前，確保 reply/blank 預設不誤選共用。

**Step 7 — 全量驗證**
- `npx vitest run --config web/vitest.config.ts` + `npm run test:workers` 全綠。
- `tsc`/lint（依既有 CI）。
- 執行 §4 手動視覺驗證 1–6（HITL，需 02/04 test 環境 + 種子）。

---

## 6. Design constraints

- **zh-tw 字級 + 行高**：body 已全域 `line-height: 1.7` + CJK 字型堆疊（`web/src/index.css:42-46`：Plus Jakarta Sans → Noto Sans SC → PingFang/YaHei）。新文字/badge **不覆寫** line-height/font-size，繼承既有；badge 用既有 `text-[10px]`/`text-xs` 級距（對齊 ThreadList source-chip `text-[10px]`），不引入新字級。
- **比照既有元件樣式**：badge 走 ui/ 既有模式（`button.tsx` 的 cn + variant、`card.tsx`/`input.tsx` 的 `rounded-* border-border bg-* px-* py-*`）。「共用」chip 直接沿用 ThreadList 既有 source-address chip 的 token（`rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground`），確保零新設計語言。
- **「共用」badge 須與個人信箱視覺可分**：原生 `<select><option>` 不能放彩色 node，故選單內用**文字後綴「（共用）」**；非 select 的清單/row 用彩色 `<Badge>`（建議 `--brand-gold` 或 `--brand-orange` token 邊框/底，與中性 muted source-chip 區隔）。
- **未認領狀態須 glanceable**：`unclaimed` badge 用比「共用」更高對比的暖色（`--brand-orange`，HSL `23 98% 51%`），放在 ThreadRow 顯眼處（subject 行附近），讓使用者掃視即知「公海待領」。文字「未認領」。
- **無回歸 / 無新設計語言**：色彩僅取 `index.css` 既有 brand token（`--brand-gold` / `--brand-orange` / `--primary`），不新增 CSS 變數；間距/圓角沿用 `--radius` 與既有 px/py 級距。
