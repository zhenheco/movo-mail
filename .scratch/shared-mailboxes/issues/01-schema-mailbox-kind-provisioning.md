Status: closed
Type: feat

# 01 — Schema + 信箱分型 + 供裝

## Parent

`.scratch/shared-mailboxes/PRD.md`

## What to build

引入「共用信箱」的底層資料模型與供裝路徑，端到端可驗：建得出一個 `kind=shared`、無 owner 的信箱，且既有個人信箱完全不受影響。

- 新增 migration `0004`：
  - `mailboxes` 加 `kind`（`'personal'` 預設 ｜ `'shared'`）。
  - `threads` 加 `assignee_id`（指向 user，可空；user 刪除時設 NULL；NULL = 未認領／個人信箱忽略）。
- `POST /admin/mailboxes` 接受可選 `kind`；當 `kind='shared'` 時 `ownerEmail` 可空（不建 owner 關聯）；`kind='personal'`（或省略）維持現狀，需有效 owner。位址格式 regex 不變。
- 既有個人信箱因 `kind` 預設 `'personal'`，行為零回歸。

> Schema（來自設計決策，非 prototype）：
> `ALTER TABLE mailboxes ADD COLUMN kind TEXT NOT NULL DEFAULT 'personal';`
> `ALTER TABLE threads ADD COLUMN assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL;`

## Acceptance criteria

- [ ] migration `0004` 套用到 dev/test D1 成功，欄位與預設值正確
- [ ] `POST /admin/mailboxes` 可建立 `kind='shared'` 且不帶 owner 的信箱
- [ ] `kind='personal'`（或省略 kind）仍要求有效 owner，行為與現狀一致
- [ ] 既有個人信箱讀寫/登入/可見性無回歸（kind 預設 personal）
- [ ] 對應測試涵蓋：建 shared（無 owner）成功、建 personal 無 owner→拒絕

## Blocked by

None - can start immediately
