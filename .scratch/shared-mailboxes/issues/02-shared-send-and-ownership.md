Status: closed
Type: feat

# 02 — 共用信箱寄信 + 寄件歸屬

## What to build

讓任一登入使用者都能從共用信箱寄信，且從共用信箱開啟的新對話立即歸寄信者所有。

- 新增「可寄信集合」概念 = 使用者擁有的個人信箱 ∪ 全部共用信箱。寄信驗證改用此集合（不再只限 owned）。
- `from` 地址維持 server 強制 = 信箱地址（client 不可偽造）。
- 從共用信箱寄出、且為**新對話**（非回覆既有 thread）時，建立的 thread `assignee_id = 寄信者 user id`。
- 個人信箱寄信維持現狀：僅擁有者可寄；非擁有者選別人個人信箱 → 403。
- **不可**汙染登入閘門：解析「使用者擁有的信箱」（登入放行 + 個人讀取範圍）的既有函式維持「只回個人信箱」，可寄集合用獨立路徑計算。

## Acceptance criteria

- [ ] 任一登入 user 可指定共用信箱為寄件地址並成功寄出
- [ ] 寄件 `from` 被 server 強制為信箱地址（偽造的 client `from` 無效）
- [ ] 非擁有者嘗試從別人的個人信箱寄信 → 403
- [ ] 從共用信箱開新對話 → 該 thread `assignee_id` = 寄信者
- [ ] 登入放行邏輯（擁有 ≥1 信箱才放行）不因共用信箱存在而改變
- [ ] 測試涵蓋上述行為（共用可寄、個人 403、from 強制、新對話 assignee=sender）

## Blocked by

- `.scratch/shared-mailboxes/issues/01-schema-mailbox-kind-provisioning.md`
