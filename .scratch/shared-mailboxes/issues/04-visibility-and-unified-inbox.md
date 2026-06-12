Status: ready-for-agent
Type: feat

# 04 — 可見性（個人/共用/admin）+ 統一收件匣

## What to build

依信箱類型與歸屬人，正確過濾每個使用者看得到的對話，並讓統一收件匣涵蓋共用信箱。

- 可見性規則：
  - 個人信箱（自己擁有）：看全部（不變）。
  - 個人信箱（別人的）：看不到（含 admin 也看不到別人個人信箱內容）。
  - 共用信箱：一般使用者看 `assignee = 自己` **或** `assignee IS NULL`。
  - 共用信箱（admin）：看全部，含別人已認領的對話。
- 統一收件匣（`GET /api/threads/all` 或等效）= 個人信箱全部 + 共用信箱（我的 + 未認領）；admin 額外含共用信箱所有已認領對話。
- 單一 thread / 訊息讀取端點同樣套用上述授權（避免越權讀別人已認領或別人個人信箱）。

## Acceptance criteria

- [ ] 共用信箱列表：使用者只見 `assignee = me OR NULL`
- [ ] Priss 看不到 Kee 已認領的共用對話（反之亦然）
- [ ] 未認領共用對話 Kee、Priss 都看得到
- [ ] 統一收件匣含個人信箱全部 + 共用信箱（我的 + 未認領）
- [ ] admin 看得到共用信箱所有對話（含他人已認領）
- [ ] admin 看不到別人的個人信箱內容
- [ ] 越權讀取單一 thread/訊息被擋（403/404）
- [ ] 個人信箱可見性無回歸
- [ ] 測試涵蓋上述行為

## Blocked by

- `.scratch/shared-mailboxes/issues/03-inbound-routing-and-claim.md`
