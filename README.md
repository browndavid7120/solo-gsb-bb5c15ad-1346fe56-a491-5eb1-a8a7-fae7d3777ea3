# 纸质展品光照额度管理（Light Quota）

面向纸本、拓本等光敏展品的**年度照度时数（剂量，单位 lx·h）额度管理** Web 应用。
Node.js（Express）+ PostgreSQL，本地账号区分两类角色：

- **保管员（conservator）**：登记展品与每年照度时数上限、批准/驳回/复核布展计划、录入并确认实测。
- **布展员（installer）**：创建展出计划（展期、每日开灯时段、预计照度），查看额度占用。

## 核心业务规则

1. **按自然年拆分剂量**：以墙上时间（默认中国标准时间 UTC+08:00，固定偏移不处理夏令时）归属年份。
   - 每日开灯时段支持多段、支持跨午夜（如 `20:00-02:00`）；计划可以跨年，剂量自动切到各自然年。
2. **时间重叠不得批准**：同一展品，两条已批准/待复核计划只要**开灯时刻区间相交**即拒绝批准
   （即使展出日期有重叠但开灯时段不相交，也允许）。
3. **批准时合计校验**：
   `已确认实测剂量` + `其他已批准/待复核计划尚未被实测覆盖部分的估算剂量` + `本计划估算剂量`，
   任一自然年超过该展品年度上限即拒绝，并在错误信息与页面中列出**超限年份、上限、各部分占用与超额量（lx·h）**。
4. **并发安全**：批准/确认事务先对展品行加 `SELECT ... FOR UPDATE` 行锁，串行化同展品的并发批准，防止超配。
5. **实测替代估算**：展后保管员在「已批准计划的开灯时段内」录入实测时段与照度，确认后该时段改按实测计量，
   原估算的对应部分自动扣除；已确认测量记录与审批记录保留（不可修改/删除）。
6. **重叠实测拒绝**：实测时段与同展品任何未作废实测时间相交即拒绝（含待确认记录）。
7. **迟到实测导致超限**：确认实测若使某展品某自然年已用剂量超限，
   该展品在**相应年度仍有估算剂量、且尚未开始**的已批准计划自动转为 **待复核（pending_review）**，
   页面展示原因；保管员复核通过时重新执行完整的重叠+额度校验。原审批与测量记录均保留。
8. **校验报错**：非法日期/时间、零时长或互相重叠的开灯时段、非正照度/上限等一律返回明确中文错误。
9. 页面按展品展示**每个自然年的上限、已占用、剩余额度**，以及逐条占用来源
   （已确认实测、各计划估算残余，含按年剂量）。

## 一键启动（Docker Compose）

前置：已安装 Docker 与 Docker Compose（v2）。

```bash
cd <本项目目录>
docker compose up --build -d
```

启动后访问：

- **应用地址：http://localhost:3000**
- PostgreSQL 仅映射到本机：`localhost:5432`（排查用，可在 compose 中删除 ports 段）

首次启动会自动：建表 → 创建两个默认账号 → 写入一个演示展品与一条跨年已批准计划（可用 `SEED_DEMO=false` 关闭）。

默认账号（**请在生产环境修改**）：

| 角色 | 用户名 | 密码 |
| --- | --- | --- |
| 保管员 | `custodian` | `guard123` |
| 布展员 | `installer` | `setup123` |

停止与清理：

```bash
docker compose down          # 停止（保留数据卷）
docker compose down -v       # 停止并删除数据库数据卷（完全重置）
docker compose logs -f app   # 查看应用日志
```

## 配置（环境变量）

可在项目根目录放 `.env`（参考 `.env.example`），或 `docker compose up` 前在 shell 中导出：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 宿主机映射端口（容器内固定 3000） |
| `DB_PORT` | `5432` | PostgreSQL 映射到宿主机的端口 |
| `PGHOST` | `db` | 数据库主机（Compose 内置网络中的服务名） |
| `PGPORT` | `5432` | 数据库端口 |
| `PGDATABASE` | `lightquota` | 数据库名 |
| `PGUSER` | `lightquota` | 数据库用户 |
| `PGPASSWORD` | `lightquota_secret` | 数据库密码 |
| `TZ_OFFSET_MINUTES` | `480` | 墙上时间相对 UTC 的固定偏移（分钟），中国为 480 |
| `SEED_CONSERVATOR_USERNAME` / `SEED_CONSERVATOR_PASSWORD` | `custodian` / `guard123` | 初始保管员账号（仅首次初始化时创建） |
| `SEED_INSTALLER_USERNAME` / `SEED_INSTALLER_PASSWORD` | `installer` / `setup123` | 初始布展员账号 |
| `SEED_DEMO` | `true` | 是否写入演示展品/计划 |

修改账号相关变量后若库中已存在同名用户不会重复创建；需要重置初始数据可 `docker compose down -v` 后重新启动。

## 本地（非 Docker）运行

```bash
npm install
# 准备一个可访问的 PostgreSQL，然后设置 PG* 环境变量（PGHOST 默认指向 compose 的 db）
PGHOST=127.0.0.1 PGUSER=lightquota PGPASSWORD=lightquota_secret npm start
```

核心剂量算法的离线自测（不需要数据库）：

```bash
npm run test:utils
```

## 使用流程

1. 保管员登录 → 「展品与额度」登记展品，并为相关自然年登记年度上限（lx·h）。
2. 布展员登录 → 「布展计划」选择展品、填展期、每日开灯时段（每行一段 `HH:MM-HH:MM`）、预计照度后提交；
   提交时即检查与已批准计划的开灯时间重叠。
3. 保管员在展品详情中查看按年预计剂量，执行批准/驳回；超限时会列出年份与超额量。
4. 展后保管员在「实测记录」录入已批准计划内的实测时段与照度 → 确认；
   若迟到实测造成年度超限，相应未开始计划转待复核，保管员在详情页复核。
5. 「操作流水」保留全部审批、确认、状态变更等记录。

## 目录结构

```
src/
  server.js        启动入口（等待数据库、初始化、起 HTTP 服务）
  app.js           Express 应用与统一错误处理
  config.js        环境变量配置
  db.js            pg 连接池、事务封装、类型解析
  init.js          建表、初始账号、演示数据
  schema.sql       表结构
  auth.js          会话与角色中间件、bcrypt 登录校验
  audit.js         操作流水写入
  validation.js    中文输入校验（时段/日期/正数等）
  dosing.js        剂量核心算法：时间窗、按年拆分、区间扣除、重叠/包含判断
  service.js       额度占用计算、批准校验、实测窗口校验、待复核筛选
  routes/          auth/users/exhibits/plans/measurements/audit 路由
public/            原生 HTML/CSS/JS 单页界面
scripts/test-utils.js  核心算法离线测试
Dockerfile / docker-compose.yml
```
