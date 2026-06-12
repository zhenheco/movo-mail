Status: ready-for-agent
Type: feat

# 03 — 收信歸屬 + 公海 + 回覆即認領

## What to build

讓共用信箱的收信依「歸屬人」分流，並支援「回覆即認領」公海新信。

- 收信存檔路由維持不變（依地址找信箱存入）。在此之上：
  - 回信命中既有 thread（References/In-Reply-To）→ 維持該 thread 現有 `assignee`（誰寄的回誰）。
  - 全新客人來信、對不到任何 thread → 新建 thread `assignee_id = NULL`（未認領／公海）。
  - 個人信箱新 thread → `assignee_id = NULL`（被忽略，照 owner 可見）。
- 認領（claim）：使用者對「共用信箱且 `assignee IS NULL`」的對話按回覆並送出時，原子認領該 thread 給自己。
  - 原子性：`UPDATE threads SET assignee_id = ? WHERE id = ? AND assignee_id IS NULL`（first-write-wins）。
  - 並發時只有一人成功；落敗者的回信仍正常寄出，thread 歸先到者。
- v1 只做「回覆即認領」，不另做獨立「認領」按鈕。

## Acceptance criteria

- [ ] 全新客人寄共用地址（無對應 thread）→ 新 thread `assignee_id = NULL`
- [ ] 回信命中既有 thread → `assignee` 不變
- [ ] 回覆未認領共用對話 → 原子認領，`assignee` 變成回覆者
- [ ] 並發認領 first-write-wins（測試模擬兩請求，只有一個寫入成功）
- [ ] 個人信箱收信行為無回歸
- [ ] 測試涵蓋上述行為

## Blocked by

- `.scratch/shared-mailboxes/issues/02-shared-send-and-ownership.md`
