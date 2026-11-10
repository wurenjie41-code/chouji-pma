# 筹记 PWA V1 本机数据模型

## IndexedDB

数据库名由 `chouji-local-v1-` 和应用部署路径组成，版本：`1`。IndexedDB 按浏览器来源共享，不按网址路径隔离；路径后缀避免同一 `github.io` 主机上的不同项目页误用同一个数据库。包含三个 object store：

| Store | Key | 用途 |
|---|---|---|
| `meta` | `vault` | KDF 名称、轮数、随机 salt 和创建时间。Salt 不保密；它不能用于还原口令。 |
| `state` | `main` | 当前主账本的加密 envelope。 |
| `snapshots` | `snapshot-{sequence}` | 每次成功提交的加密状态快照，最多保留最近 5 份。 |

明文账本只在解锁后的 JavaScript 会话内存中短暂存在；`state` 和 `snapshots` 中的完整账本 payload 均为 AES-GCM ciphertext。Envelope 的版本号、递增序号、更新时间和 IV 以明文保存，供解密版本选择与诊断使用；这些元数据会暴露更新次数和时间。AES-GCM Additional Authenticated Data 绑定序号，篡改序号会导致解密失败。

## 加密流程

1. 建账时生成 128-bit 随机 salt。
2. 用户口令经 PBKDF2-SHA256、600,000 轮派生 AES-256-GCM key；不保存口令或可导出 key。
3. 每次提交生成新的 96-bit 随机 IV。
4. 加密 JSON 序列化的完整状态，包含记录、备注和日期。
5. 单个 IndexedDB read-write transaction 原子写入主状态与新快照，并删除超出 5 份上限的旧快照。

## 资金流水

V1 为单账本、单币种 CNY；所有金额用整数分保存，不以浮点金额计算。状态 payload 形状：

```json
{
  "sequence": 12,
  "createdAt": "2026-11-11T01:00:00.000Z",
  "records": [
    {
      "id": "UUID",
      "kind": "stake",
      "amountMinor": 1250,
      "deltaMinor": -1250,
      "date": "2026-11-11",
      "note": "可选备注",
      "createdAt": "2026-11-11T01:03:00.000Z"
    }
  ]
}
```

| `kind` | 标签 | `deltaMinor` | 是否计入投注净结果 |
|---|---|---:|---|
| `stake` | 投注支出 | `-amountMinor` | 是 |
| `payout` | 派彩返还 | `+amountMinor` | 是 |
| `refund` | 退款 / 退回 | `+amountMinor` | 是 |
| `deposit` | 账户存入 | `+amountMinor` | 否 |
| `withdrawal` | 账户取出 | `-amountMinor` | 否 |

投注净结果 = 派彩 + 退款 - 投注支出。存取款只作为资金移动记录显示，不影响投注净结果。金额必须大于 0、最多两位小数；备注最多 120 个字符。记录修改或删除会生成新的完整加密状态和快照；最近的 5 个提交版本允许“恢复上一份快照”。

## 不在本版范围

多币种、多账户、转账、外部赛事/赔率 API、云同步和 OCR。当前的滚动快照与 IndexedDB 共用相同来源存储，不是异地备份；口令丢失或浏览器源数据被清除后无法恢复。
