/**
 * 员工通讯录直查库（表默认 `uc_staff`）。
 * 直接连 MySQL 员工主数据表，替代对 om-user HTTP 服务的依赖：
 *  - lookupStaff：按纯域账号查单个在职员工（登录校验用）
 *  - listActiveStaff：全量在职员工（通讯录「真人」区展示 + 登录身份匹配）
 *
 * 连接**全部来自环境变量**，代码内不内置任何地址 / 口令：
 *   STAFF_DB_HOST / STAFF_DB_PORT / STAFF_DB_USER / STAFF_DB_PASSWORD / STAFF_DB_NAME / STAFF_DB_TABLE
 * 未配置 STAFF_DB_HOST 时该能力自动停用（通讯录只显示 AI 成员），不影响其它功能。
 * mysql2 驱动采用懒加载：缺失/不可用时只报错不拖垮 server 启动。
 */
import type { Pool, RowDataPacket } from "mysql2/promise";

export interface StaffHit {
  name: string;
  domainAccount: string;
  title?: string;
  staffNo?: string;
}

/** 通讯录真人条目（id 与工作区成员体系对齐：h_<域账号>） */
export interface StaffContact {
  id: string;
  name: string;
  domainAccount: string;
  title?: string;
  staffNo?: string;
}

interface StaffRow extends RowDataPacket {
  cn_name: string;
  staff_name: string;
  domain_account: string;
  department_name: string;
  post_title: string;
  staff_no: string;
}

const DB_TABLE = process.env.STAFF_DB_TABLE || "uc_staff";

/**
 * 连接配置：**全部取自环境变量**，代码内不内置任何地址 / 口令（见 `.env.example`）。
 * 未配置 `STAFF_DB_HOST` 视为不启用该能力，返回 null。
 * --- @ty.aicoding@1789633552900 ---
 */
function dbConfig() {
  const host = (process.env.STAFF_DB_HOST || "").trim();
  if (!host) return null;
  return {
    host,
    port: Number(process.env.STAFF_DB_PORT || 3306),
    user: process.env.STAFF_DB_USER || "root",
    password: process.env.STAFF_DB_PASSWORD || "",
    database: process.env.STAFF_DB_NAME || "staff",
    charset: "utf8mb4",
    connectTimeout: 6000, // 库不可达时快速失败
    connectionLimit: 3,
    waitForConnections: true,
  };
}

let pool: Pool | null = null;
let loadError: string | null = null;
let lastAttempt = 0;
const RETRY_GAP_MS = 30_000; // 连接失败后 30s 内不重复尝试

async function getPool(): Promise<Pool | null> {
  if (pool) return pool;
  if (loadError && Date.now() - lastAttempt < RETRY_GAP_MS) return null;
  const cfg = dbConfig();
  if (!cfg) {
    loadError = null; // 未配置即未启用，不算故障
    return null;
  }
  try {
    const mod = await import("mysql2/promise");
    const p = mod.createPool(cfg);
    // 建池后立刻 ping 一次，把不可达/密码错等尽早暴露成 loadError
    const conn = await p.getConnection();
    conn.release();
    pool = p;
    loadError = null;
  } catch (e) {
    pool = null;
    loadError = (e as Error).message;
    lastAttempt = Date.now();
  }
  return pool;
}

/** 通讯录库就绪状态（启动自检用；返回不含密码的脱敏连接描述） */
export function staffDbStatus() {
  const c = dbConfig();
  return {
    ready: !!pool,
    enabled: !!c,
    error: loadError,
    host: c ? `${c.host}:${c.port}/${c.database}` : "",
    table: DB_TABLE,
  };
}

/**
 * 按纯域账号查在职员工。account 需已 normalize（小写、无域前缀）。
 * 过滤：is_active=1 且 status=1 且未离职（dimission_date 为空或晚于当前）。
 */
export async function lookupStaff(account: string): Promise<{ ok: boolean; error?: string; staff?: StaffHit }> {
  if (!account) return { ok: false, error: "域账号不能为空" };
  const p = await getPool();
  if (!p) {
    return {
      ok: false,
      error: loadError
        ? `员工库连接失败：${loadError}（请检查网络/账号或 STAFF_DB_* 环境变量）`
        : "员工库未启用：未配置 STAFF_DB_HOST（见 .env.example）",
    };
  }
  try {
    const [rows] = await p.execute<StaffRow[]>(
      `SELECT cn_name, staff_name, domain_account, department_name, post_title, staff_no
       FROM \`${DB_TABLE}\`
       WHERE domain_account = ? AND is_active = 1 AND status = 1
         AND (dimission_date IS NULL OR dimission_date > NOW())
       LIMIT 1`,
      [account]
    );
    const r = rows[0];
    if (!r) return { ok: false, error: `未找到在职员工，域账号「${account}」` };
    const rawName = String(r.cn_name || "").trim();
    const name = (rawName && rawName !== "无" ? rawName : String(r.staff_name || account).trim()) || account;
    return {
      ok: true,
      staff: {
        name: name.slice(0, 30),
        domainAccount: String(r.domain_account || account).toLowerCase(),
        title: [r.department_name, r.post_title].filter(Boolean).join(" · ").slice(0, 60) || undefined,
        staffNo: String(r.staff_no || "").trim() || undefined,
      },
    };
  } catch (e) {
    return { ok: false, error: `查询员工库失败：${(e as Error).message}` };
  }
}

function rowToContact(r: StaffRow): StaffContact {
  const da = String(r.domain_account || "").trim().toLowerCase();
  const rawName = String(r.cn_name || "").trim();
  const name = (rawName && rawName !== "无" ? rawName : String(r.staff_name || da).trim()) || da;
  return {
    id: `h_${da}`,
    name: name.slice(0, 30),
    domainAccount: da,
    title: [r.department_name, r.post_title].filter(Boolean).join(" · ").slice(0, 60) || undefined,
    staffNo: String(r.staff_no || "").trim() || undefined,
  };
}

/**
 * 全量在职员工列表（通讯录真人区 + 登录校验共用）。
 * 与 lookupStaff 相同的在职过滤，另要求 domain_account 非空。
 */
export async function listActiveStaff(): Promise<{ ok: boolean; staff?: StaffContact[]; error?: string }> {
  const p = await getPool();
  if (!p) {
    return {
      ok: false,
      error: loadError
        ? `员工库连接失败：${loadError}（请检查网络/账号或 STAFF_DB_* 环境变量）`
        : "员工库未启用：未配置 STAFF_DB_HOST（见 .env.example）",
    };
  }
  try {
    const [rows] = await p.execute<StaffRow[]>(
      `SELECT cn_name, staff_name, domain_account, department_name, post_title, staff_no
       FROM \`${DB_TABLE}\`
       WHERE is_active = 1 AND status = 1 AND domain_account <> ''
         AND (dimission_date IS NULL OR dimission_date > NOW())
       ORDER BY domain_account`
    );
    return { ok: true, staff: rows.map(rowToContact) };
  } catch (e) {
    return { ok: false, error: `查询员工列表失败：${(e as Error).message}` };
  }
}
