Status: ready-for-agent
Type: feat

# 05 — 前端：寄件選單 + 共用標記 + 未認領狀態

## What to build

前端讓共用信箱可被選為寄件地址、視覺上與個人信箱可區分，並標示未認領狀態。

- Compose 寄件選單 `fromOptions` 含全部共用信箱（不只自己擁有的個人信箱）。
- 共用信箱在寄件選單與信箱清單顯示「共用」標記（badge / 後綴），與個人信箱可一眼區分。
- 收件匣列表對「未認領」的共用對話顯示可辨識狀態（讓使用者知道這是公海待領、非私有）。
- 中文字體/行高遵循既有設計規範（zh-tw 較大字級 + 較寬行高）。

## Acceptance criteria

- [ ] Compose `fromOptions` 列出全部共用信箱，可選並成功寄出
- [ ] 共用信箱在選單與清單有「共用」標記，與個人信箱可區分
- [ ] 未認領共用對話在收件匣有可辨識狀態提示
- [ ] 視覺符合既有設計系統（字體/行高/間距）
- [ ] 既有 Compose / 收件匣行為無回歸

## Blocked by

- `.scratch/shared-mailboxes/issues/02-shared-send-and-ownership.md`
- `.scratch/shared-mailboxes/issues/04-visibility-and-unified-inbox.md`
