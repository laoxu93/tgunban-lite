// tgunban-lite — 精简版 Telegram 群组自助解封机器人
// Cloudflare Workers + D1，无 AI、无外部黑名单、无杀手模式。
// 核心只有：自助解封 / 管理员封禁解封 / 查询 / 导出 / 清扫。
// 所有密钥一律走环境变量，源码里没有任何默认值、没有任何硬编码密钥。
// 自助解封口令 SELF_UNBAN_KEYWORD 没有默认值，未配置时自助解封直接拒绝。

const TG_API = 'https://api.telegram.org';

// ---------- 工具 ----------

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function parseIds(s) {
  return String(s || '').split(/[,，\s]+/).map(x => x.trim())
    .filter(Boolean).map(Number).filter(n => Number.isFinite(n));
}

function isOwner(env, userId) {
  return parseIds(env.OWNER_IDS).includes(Number(userId));
}

// ---------- Telegram API（唯一对外请求目标） ----------

async function tg(env, method, body = {}) {
  const res = await fetch(`${TG_API}/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method} 失败: ${data.description || res.status}`);
  return data.result;
}

async function sendMessage(env, chatId, text, extra = {}) {
  return tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

async function getChatMember(env, chatId, userId) {
  try { return await tg(env, 'getChatMember', { chat_id: chatId, user_id: userId }); }
  catch { return null; }
}

// 管理员判定：主人（OWNER_IDS）或该群的 Telegram 管理员
async function isGroupAdmin(env, chatId, userId) {
  if (isOwner(env, userId)) return true;
  const m = await getChatMember(env, chatId, userId);
  return m && (m.status === 'administrator' || m.status === 'creator');
}

// ---------- D1：表结构自动建立 ----------

async function ensureSchema(env) {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '', by_user INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(chat_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL, chat_id INTEGER, user_id INTEGER,
      by_user INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS unban_requests (
      user_id INTEGER PRIMARY KEY,
      last_at INTEGER NOT NULL
    );`);
}

async function audit(env, action, chatId, userId, byUser, reason = '') {
  await env.DB.prepare(
    'INSERT INTO audit_log (action, chat_id, user_id, by_user, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(action, chatId ?? null, userId ?? null, byUser ?? 0, reason, new Date().toISOString()).run();
}

async function addBlacklist(env, chatId, userId, reason, byUser) {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO blacklist (chat_id, user_id, reason, by_user, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(chatId, userId, reason, byUser, new Date().toISOString()).run();
}

async function removeBlacklist(env, chatId, userId) {
  const r = await env.DB.prepare(
    'DELETE FROM blacklist WHERE chat_id = ? AND user_id = ?'
  ).bind(chatId, userId).run();
  return (r.meta?.changes ?? 0) > 0;
}

async function isBlacklisted(env, chatId, userId) {
  const row = await env.DB.prepare(
    'SELECT 1 AS x FROM blacklist WHERE chat_id = ? AND user_id = ?'
  ).bind(chatId, userId).first();
  return !!row;
}

// 自助解封限流：每人每小时 1 次（成功失败都计）
async function checkUnbanRateLimit(env, userId) {
  const now = Date.now();
  const row = await env.DB.prepare(
    'SELECT last_at FROM unban_requests WHERE user_id = ?'
  ).bind(userId).first();
  if (row && now - Number(row.last_at) < 3600_000) {
    return Math.ceil((3600_000 - (now - Number(row.last_at))) / 60000);
  }
  await env.DB.prepare(
    'INSERT OR REPLACE INTO unban_requests (user_id, last_at) VALUES (?, ?)'
  ).bind(userId, now).run();
  return 0;
}

// ---------- 配置 ----------

function groupIds(env) {
  const ids = parseIds(env.GROUP_ID);
  if (!ids.length) throw new Error('未配置 GROUP_ID');
  return ids;
}

function requireEnv(env, name) {
  const v = String(env[name] || '').trim();
  if (!v) throw new Error(`未配置 ${name}`);
  return v;
}

// ---------- 命令解析 ----------

function parseCommand(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('/')) return null;
  const [cmd, ...rest] = t.split(/\s+/);
  return { cmd: cmd.split('@')[0].toLowerCase(), args: rest, raw: t };
}

function parseTargetId(args, replyTo) {
  if (replyTo?.from?.id) return Number(replyTo.from.id);
  const n = Number(args[0]);
  return Number.isFinite(n) ? n : null;
}

// ---------- Webhook 入口 ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+|\/+$/g, '');

    // --- 管理 HTTP 接口：/{TOKEN}/...，TOKEN 是路径密钥 ---
    const token = requireEnvSafe(env, 'TOKEN');
    if (token && path.startsWith(token + '/')) {
      const sub = path.slice(token.length + 1);
      if (sub === 'export') return handleExport(env, url);
      if (sub === 'purge') return handlePurge(env, url);
      return json({ error: 'unknown' }, 404);
    }
    if (token && path === token) {
      return handleInitWebhook(request, env, url);
    }
    // 根路径 GET：只给一句说明，不暴露任何信息
    if (request.method === 'GET' && path === '') {
      return new Response('tgunban-lite running', { status: 200 });
    }

    // --- Telegram Webhook：先校验 secret，再碰 D1 ---
    if (request.method === 'POST' && path === '') {
      const secret = String(env.WEBHOOK_SECRET || '').trim();
      if (!secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
        return new Response('Webhook secret is not configured correctly', { status: 503 });
      }
      const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (received !== secret) return new Response('Unauthorized', { status: 401 });
      let update;
      try { update = await request.json(); } catch { return new Response('bad json', { status: 400 }); }
      ctx.waitUntil(handleUpdate(env, update).catch(e => console.error(e)));
      return new Response('ok', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  },
};

function requireEnvSafe(env, name) {
  try { return requireEnv(env, name); } catch { return ''; }
}

// ---------- Webhook 初始化 ----------

async function handleInitWebhook(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);
  const secret = requireEnv(env, 'WEBHOOK_SECRET');
  const webhookUrl = `${url.origin}/`;
  const r = await tg(env, 'setWebhook', {
    url: webhookUrl, secret_token: secret,
    allowed_updates: ['message', 'chat_member', 'chat_join_request'],
    drop_pending_updates: true,
  });
  await tg(env, 'setMyCommands', { commands: [
    { command: 'start', description: '欢迎与使用说明' },
    { command: 'unban', description: '自助解封 / 管理员解封' },
    { command: 'check', description: '查询用户封禁状态' },
    { command: 'blacklist', description: '查看黑名单' },
    { command: 'health', description: '运行状态自检' },
    { command: 'stats', description: '简单统计' },
  ]});
  return json({ ok: true, webhook: webhookUrl, setWebhook: r });
}

// ---------- 管理 HTTP 接口 ----------

async function handleExport(env, url) {
  await ensureSchema(env);
  const format = url.searchParams.get('format') || 'json';
  const { results } = await env.DB.prepare(
    'SELECT chat_id, user_id, reason, by_user, created_at FROM blacklist ORDER BY created_at DESC LIMIT 1000'
  ).all();
  if (format === 'csv') {
    const head = 'chat_id,user_id,reason,by_user,created_at\n';
    const body = results.map(r =>
      [r.chat_id, r.user_id, JSON.stringify(r.reason || ''), r.by_user, r.created_at].join(',')).join('\n');
    return new Response(head + body, { headers: { 'content-type': 'text/csv; charset=utf-8' } });
  }
  return json({ count: results.length, blacklist: results });
}

// /{TOKEN}/purge：把仍在群里的黑名单用户全部踢出（分批，每批最多 20 人）
async function handlePurge(env, url) {
  await ensureSchema(env);
  const limit = Math.min(Number(url.searchParams.get('limit') || 20) || 20, 50);
  const { results } = await env.DB.prepare(
    'SELECT chat_id, user_id FROM blacklist ORDER BY created_at ASC LIMIT ?'
  ).bind(limit).all();
  let kicked = 0; const failed = [];
  for (const r of results) {
    try {
      await tg(env, 'banChatMember', { chat_id: r.chat_id, user_id: r.user_id });
      await audit(env, 'purge_kick', r.chat_id, r.user_id, 0, 'purge');
      kicked++;
    } catch (e) { failed.push({ chat_id: r.chat_id, user_id: r.user_id, error: String(e.message) }); }
  }
  return json({ checked: results.length, kicked, failed });
}

// ---------- 消息处理 ----------

async function handleUpdate(env, update) {
  await ensureSchema(env);
  const msg = update.message;
  if (!msg || !msg.text) return;
  // 其他机器人的消息不处理
  if (msg.from?.is_bot) return;

  const chat = msg.chat;
  const fromId = msg.from.id;
  const parsed = parseCommand(msg.text);
  if (!parsed) {
    // 私聊里发自助解封口令本身也算一次解封尝试
    if (chat.type === 'private') await trySelfUnban(env, msg, msg.text.trim());
    return;
  }
  const { cmd, args } = parsed;

  switch (cmd) {
    case '/start': return cmdStart(env, msg);
    case '/unban':
      if (chat.type === 'private') return trySelfUnban(env, msg, args.join(' '));
      return cmdAdminUnban(env, msg, args);
    case '/ban': return cmdBan(env, msg, args, false);
    case '/sban': return cmdBan(env, msg, args, true);
    case '/check': return cmdCheck(env, msg, args);
    case '/blacklist': return cmdBlacklist(env, msg);
    case '/health': return cmdHealth(env, msg);
    case '/stats': return cmdStats(env, msg);
    default: return;
  }
}

async function cmdStart(env, msg) {
  const text = [
    '👋 <b>tgunban-lite 自助解封机器人</b>',
    '',
    '被封了？私聊我发 <code>/unban</code>，按提示粘贴自助解封口令。',
    '管理员：<code>/ban 用户ID [原因]</code> 禁言，<code>/sban 用户ID [原因]</code> 踢出，',
    '<code>/unban 用户ID</code> 解封，<code>/check 用户ID</code> 查询。',
    '',
    '⚠️ 自助解封每小时只能试 1 次，只有真被封禁的人才能解封。',
  ].join('\n');
  await sendMessage(env, msg.chat.id, text);
}

// ---------- 自助解封 ----------

async function trySelfUnban(env, msg, keywordText) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // 关键安全决策：口令没有默认值，未配置就直接拒绝，不存在“公开默认口令”
  const keyword = String(env.SELF_UNBAN_KEYWORD || '').trim();
  if (!keyword) {
    await sendMessage(env, chatId, '❌ 自助解封未启用：管理员尚未配置解封口令，请联系群管理员。');
    return;
  }
  if (keywordText !== keyword) {
    await sendMessage(env, chatId,
      '📋 自助解封：请完整粘贴自助解封口令（一个字都不能多、不能少）。\n' +
      '口令请向群管理员索取。');
    return;
  }
  // 限流：每小时 1 次
  const waitMin = await checkUnbanRateLimit(env, userId);
  if (waitMin > 0) {
    await sendMessage(env, chatId, `⏳ 你已试过一次了，请 ${waitMin} 分钟后再试。`);
    return;
  }
  // 必须真被封禁/限制：查黑名单 + 各群成员状态
  const groups = groupIds(env);
  const bannedIn = [];
  for (const gid of groups) {
    if (await isBlacklisted(env, gid, userId)) { bannedIn.push(gid); continue; }
    const m = await getChatMember(env, gid, userId);
    if (m && (m.status === 'kicked' || m.status === 'restricted')) bannedIn.push(gid);
  }
  if (!bannedIn.length) {
    await sendMessage(env, chatId, 'ℹ️ 你没有被封禁，无需解封。如有疑问请联系群管理员。');
    return;
  }
  // 逐群解封：先删黑名单记录，成功才调 Telegram 解封
  let ok = 0; const failed = [];
  for (const gid of bannedIn) {
    try {
      await removeBlacklist(env, gid, userId);
      await tg(env, 'unbanChatMember', { chat_id: gid, user_id: userId, only_if_banned: true });
      await tg(env, 'restrictChatMember', {
        chat_id: gid, user_id: userId,
        permissions: { can_send_messages: true, can_send_media_messages: true,
          can_send_other_messages: true, can_add_web_page_previews: true },
      }).catch(() => {}); // 已解封但无限制时 restrict 会报错，忽略
      await audit(env, 'self_unban', gid, userId, userId, 'self-service');
      ok++;
    } catch (e) { failed.push(gid); }
  }
  if (ok) {
    await sendMessage(env, chatId,
      `✅ 已解封 ${ok} 个群。${failed.length ? `（${failed.length} 个群失败，请联系管理员）` : '欢迎回来，请遵守群规。'}`);
  } else {
    await sendMessage(env, chatId, '❌ 解封失败，请联系群管理员手动处理。');
  }
}

// ---------- 管理员命令（仅群内 + 管理员） ----------

async function requireAdminInGroup(env, msg) {
  if (msg.chat.type === 'private') {
    await sendMessage(env, msg.chat.id, '❌ 这条命令请在群里发。');
    return false;
  }
  if (!groupIds(env).includes(msg.chat.id)) {
    await sendMessage(env, msg.chat.id, '❌ 这个群不在管理范围内。');
    return false;
  }
  if (!(await isGroupAdmin(env, msg.chat.id, msg.from.id))) {
    await sendMessage(env, msg.chat.id, '❌ 只有群管理员能用这条命令。');
    return false;
  }
  return true;
}

async function cmdBan(env, msg, args, kick) {
  if (!(await requireAdminInGroup(env, msg))) return;
  const target = parseTargetId(args, msg.reply_to_message);
  if (!target) { await sendMessage(env, msg.chat.id, '用法：/ban 用户ID [原因]，或回复对方的消息发 /ban'); return; }
  if (target === msg.from.id) { await sendMessage(env, msg.chat.id, '❌ 不能封自己。'); return; }
  if (isOwner(env, target)) { await sendMessage(env, msg.chat.id, '❌ 不能封机器人主人。'); return; }
  const reason = args.slice(1).join(' ').slice(0, 200) || (kick ? 'kick' : 'mute');
  const chatId = msg.chat.id;
  try {
    if (kick) {
      await tg(env, 'banChatMember', { chat_id: chatId, user_id: target });
      await addBlacklist(env, chatId, target, reason, msg.from.id);
      await audit(env, 'sban', chatId, target, msg.from.id, reason);
      await sendMessage(env, chatId, `🚫 已踢出并拉黑 <code>${escapeHtml(target)}</code>（${escapeHtml(reason)}）`);
    } else {
      await tg(env, 'restrictChatMember', {
        chat_id: chatId, user_id: target,
        permissions: { can_send_messages: false },
      });
      await addBlacklist(env, chatId, target, reason, msg.from.id);
      await audit(env, 'ban', chatId, target, msg.from.id, reason);
      await sendMessage(env, chatId, `🔇 已禁言并拉黑 <code>${escapeHtml(target)}</code>（${escapeHtml(reason)}）`);
    }
  } catch (e) {
    await sendMessage(env, chatId, `❌ 执行失败：${escapeHtml(e.message)}（请确认机器人是管理员且有封禁权限）`);
  }
}

async function cmdAdminUnban(env, msg, args) {
  if (!(await requireAdminInGroup(env, msg))) return;
  const target = parseTargetId(args, msg.reply_to_message);
  if (!target) { await sendMessage(env, msg.chat.id, '用法：/unban 用户ID，或回复对方的消息发 /unban'); return; }
  const chatId = msg.chat.id;
  const wasListed = await removeBlacklist(env, chatId, target);
  try {
    await tg(env, 'unbanChatMember', { chat_id: chatId, user_id: target, only_if_banned: true });
    await tg(env, 'restrictChatMember', {
      chat_id: chatId, user_id: target,
      permissions: { can_send_messages: true, can_send_media_messages: true,
        can_send_other_messages: true, can_add_web_page_previews: true },
    }).catch(() => {});
    await audit(env, 'admin_unban', chatId, target, msg.from.id, '');
    await sendMessage(env, chatId,
      `✅ 已解封 <code>${escapeHtml(target)}</code>${wasListed ? '' : '（此前不在黑名单里）'}`);
  } catch (e) {
    await sendMessage(env, chatId, `❌ 解封失败：${escapeHtml(e.message)}`);
  }
}

async function cmdCheck(env, msg, args) {
  if (!(await requireAdminInGroup(env, msg))) return;
  const target = parseTargetId(args, msg.reply_to_message);
  if (!target) { await sendMessage(env, msg.chat.id, '用法：/check 用户ID'); return; }
  const chatId = msg.chat.id;
  const row = await env.DB.prepare(
    'SELECT reason, by_user, created_at FROM blacklist WHERE chat_id = ? AND user_id = ?'
  ).bind(chatId, target).first();
  const m = await getChatMember(env, chatId, target);
  const lines = [
    `🔍 用户 <code>${escapeHtml(target)}</code>`,
    `群内状态：${escapeHtml(m?.status || '未知（不在群 / 查不到）')}`,
    row
      ? `黑名单：是，原因 ${escapeHtml(row.reason || '—')}，操作人 ${escapeHtml(row.by_user)}，时间 ${escapeHtml(row.created_at)}`
      : '黑名单：否',
  ];
  await sendMessage(env, chatId, lines.join('\n'));
}

async function cmdBlacklist(env, msg) {
  if (!(await requireAdminInGroup(env, msg))) return;
  const { results } = await env.DB.prepare(
    'SELECT user_id, reason, created_at FROM blacklist WHERE chat_id = ? ORDER BY created_at DESC LIMIT 30'
  ).bind(msg.chat.id).all();
  if (!results.length) { await sendMessage(env, msg.chat.id, '📋 黑名单是空的。'); return; }
  const lines = ['📋 黑名单（最近 30 条）：', ...results.map(r =>
    `• <code>${escapeHtml(r.user_id)}</code> ${escapeHtml(r.reason || '')} <i>${escapeHtml(r.created_at)}</i>`)];
  await sendMessage(env, msg.chat.id, lines.join('\n'));
}

async function cmdHealth(env, msg) {
  if (!isOwner(env, msg.from.id) && !(await isGroupAdmin(env, msg.chat.id, msg.from.id))) {
    await sendMessage(env, msg.chat.id, '❌ 只有管理员能用。');
    return;
  }
  const me = await tg(env, 'getMe');
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM blacklist').first();
  await sendMessage(env, msg.chat.id,
    `✅ 运行正常\n机器人：@${escapeHtml(me.username || '')}\n管理群数：${groupIds(env).length}\n黑名单总数：${row?.c ?? 0}`);
}

async function cmdStats(env, msg) {
  if (!(await requireAdminInGroup(env, msg))) return;
  const b = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM blacklist WHERE chat_id = ?'
  ).bind(msg.chat.id).first();
  const a = await env.DB.prepare(
    "SELECT action, COUNT(*) AS c FROM audit_log WHERE chat_id = ? GROUP BY action"
  ).bind(msg.chat.id).all();
  const lines = [
    `📊 本群统计`,
    `黑名单人数：${b?.c ?? 0}`,
    ...a.results.map(r => `${escapeHtml(r.action)}：${r.c}`),
  ];
  await sendMessage(env, msg.chat.id, lines.join('\n'));
}
