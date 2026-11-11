# 筹记 PWA 本机数据模型

本文前面的“V1 资金流水”一节描述历史 payload。当前运行时使用状态 `schemaVersion: 2`；旧账本解锁后仅在内存补齐新字段，第一次成功保存时才生成含新字段的密文状态。数据库 stores 与加密 envelope 版本不变，旧记录不会被自动删除或推断结算状态。

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

## 加密迁移备份

导出 JSON 包含 `format`、格式版本、非敏感导出时间、KDF 元数据、主状态 envelope 与最多 5 份快照 envelope。账本流水只存在 envelope 的密文中；salt、迭代次数、序号和时间戳不加密。导入时以原口令和 salt 派生密钥，解密并校验主账本和每份快照，再通过一个 IndexedDB 事务写入。若当前来源已存在账本，导入事务中止，不覆盖现有数据。文件上限为 20 MB。

备份不包含口令。口令遗失时即使有备份也无法解密。备份文件应按敏感数据保管；离线备份适合放到与手机不同的安全位置。

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

多币种、多账本、转账、外部赛事/赔率 API、云同步和 OCR。滚动快照与 IndexedDB 共用相同来源存储；只有主动保存并保管导出的加密文件才形成独立副本。口令丢失且无可用密钥时无法解密。

## 当前状态 schema 2

状态顶层包含 `schemaVersion: 2`、`sequence`、`createdAt`、旧版 `records[]`、新增 `wagers[]`、`riskSettings` 和最多 500 条 `auditLog[]`。账户存取、奖金和独立退款继续存入现有 `records[]`；不新建第二套现金流水，避免同一笔存取或返还重复计账。`cashTransactions[]` 并不存在于当前实现。

旧记录保留原字段。`stake` 和 `payout` 仍作为未关联历史显示，无法判断它们对应哪注或是否已结算。旧 `refund` 没有 `legacyType` 时继续按旧版未关联盈亏处理；新建独立退款写 `legacyType: false`，只进入资金变化，不进入旧投注净结果。新建旧版 stake/payout 被禁止；历史行仍可编辑和删除以便纠错。

### 逐注投注 `wagers[]`

每条记录包含：

| 字段 | 存储口径 |
|---|---|
| `placedAt`, `settledAt` | ISO 时间戳；未结算时 `settledAt: null` |
| `event`, `sport`, `league`, `market`, `platform` | 用户填写的事件和分类文字 |
| `oddsMilli` | 十进制赔率乘 1000 后的整数，未填为 `null` |
| `stakeMinor`, `actualReturnMinor`, `feeMinor` | CNY 整数分；未结算时返还为空、手续费为 0 |
| `combo`, `status`, `result` | 单关/串关；open、won、lost、void、cashout；赛果文字 |
| `tags`, `note`, `beforeState`, `source` | 标签、备注、下注前状态、来源；当前来源为 `manual` |
| `id`, `createdAt`, `updatedAt` | UUID 与创建/修改时间 |

`wagerResult = actualReturnMinor - stakeMinor - feeMinor`。ROI 只计入已结算且非作废投注：`ROI = 已结算投注净结果 ÷ 已结算投注额`。作废注不计入 ROI 分子或分母，但实际返还仍计入资金变化。未结算投注不计返还或净结果，未结算本金独立展示为资金敞口。每注返还不再另建 payout 流水。

### 风险设置 `riskSettings`

包含 `period`（monthly/weekly）、`budgetMinor`、`lossLimitMinor`、`maxStakeMinor`、可选 `allowedStart`/`allowedEnd`、`cooloffUntil` 和 `stoppedPeriodKey`。金额上限默认为空，由用户设置；本周期已有投注后不允许提高/取消金额上限或放宽时段。预算按投注日期累计本金，赢款不返还额度。亏损风险占用把当期已结算净亏损与未结算本金合并用于拦截，文案明确未结算本金不是已发生亏损。硬限制仅作用于应用内新增投注。

### 审计历史与备份

投注、流水和风险设置修改都会进入加密 payload 的 `auditLog[]`，保存时间、实体 ID、操作及前后值，最多保留 500 条。密文备份格式仍为版本 1；导入时解密后补齐旧字段并校验金额、状态、字段类型及快照。备份导入只写入空账本。浏览器内快照可能随本机网站数据一起丢失，需另行导出密文文件。
