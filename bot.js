require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { parseIntent } = require('./gemini');
const { savePassword, getPassword, listServices, deletePassword, countPasswords } = require('./db');
const { encrypt, decrypt, generatePassword } = require('./crypto');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const ALLOWED_IDS = process.env.ALLOWED_CHAT_IDS.split(',').map(id => parseInt(id.trim()));
const MASTER_KEY = process.env.MASTER_KEY;
const AUTO_DELETE_MS = 45000; // Las respuestas con contraseñas se borran a los 45s

function isAuthorized(chatId) {
  return ALLOWED_IDS.includes(chatId);
}

// Borra un mensaje después de N ms (silencioso si ya fue borrado)
function autoDelete(chatId, messageId, ms = AUTO_DELETE_MS) {
  setTimeout(() => bot.deleteMessage(chatId, messageId).catch(() => {}), ms);
}

// Envía un mensaje con contraseña y lo programa para autoborrarse
async function sendSecret(chatId, text, options = {}) {
  const sent = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...options });
  autoDelete(chatId, sent.message_id);
  return sent;
}

// ─── Comandos explícitos ───────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  const count = await countPasswords();
  bot.sendMessage(msg.chat.id,
    `🔐 *Pass-Bot activo*\n` +
    `_${count} contraseña${count !== 1 ? 's' : ''} guardada${count !== 1 ? 's' : ''}_\n\n` +
    `Habla conmigo en lenguaje natural:\n\n` +
    `*Guardar*\n` +
    `› _guarda gmail: user@gmail.com / Pass123_\n` +
    `› _ionos user: info@web.com pass: Abc#2026_ (reenvía mensajes de chat)\n\n` +
    `*Consultar*\n` +
    `› _¿cuál es la clave de netflix?_\n` +
    `› _dime la contraseña de ionos_\n\n` +
    `*Listar*\n` +
    `› _qué servicios tengo_\n\n` +
    `*Borrar*\n` +
    `› _borra netflix_\n\n` +
    `*Generar contraseña segura*\n` +
    `› _genera una contraseña de 20 caracteres_\n\n` +
    `⏱ _Las respuestas con contraseñas se auto-borran en 45 segundos_`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/lista/, async (msg) => {
  if (!isAuthorized(msg.chat.id)) return;
  await handleList(msg.chat.id);
});

// ─── Confirmación de borrado (inline keyboard) ────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  if (!isAuthorized(chatId)) return bot.answerCallbackQuery(query.id);

  const [action, service] = query.data.split(':');

  if (action === 'del_confirm') {
    const deleted = await deletePassword(service);
    bot.editMessageText(
      deleted ? `🗑️ *${service}* eliminado.` : `❌ No encontré *${service}*.`,
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
    );
  } else if (action === 'del_cancel') {
    bot.editMessageText('↩️ Cancelado.', { chat_id: chatId, message_id: query.message.message_id });
  }

  bot.answerCallbackQuery(query.id);
});

// ─── Handlers ─────────────────────────────────────────────────────────────

async function handleList(chatId) {
  const services = await listServices();
  if (!services.length) {
    return bot.sendMessage(chatId, '📭 No hay contraseñas guardadas todavía.');
  }
  const lines = services.map(s => {
    const user = s.username ? decrypt(s.username, MASTER_KEY) : null;
    const date = s.updated_at ? s.updated_at.split(' ')[0] : '';
    return `• *${s.service}*${user ? ` — \`${user}\`` : ''}  _${date}_`;
  }).join('\n');
  bot.sendMessage(chatId,
    `📋 *${services.length} servicio${services.length !== 1 ? 's' : ''} guardado${services.length !== 1 ? 's' : ''}*\n\n${lines}`,
    { parse_mode: 'Markdown' }
  );
}

// ─── Mensaje principal ────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  if (!isAuthorized(chatId)) {
    bot.sendMessage(chatId, '⛔ No autorizado.');
    console.warn(`Acceso denegado — chat_id: ${chatId}`);
    return;
  }

  // Los comandos /start y /lista ya los manejan los listeners de arriba
  if (text.startsWith('/')) return;

  try {
    await bot.sendChatAction(chatId, 'typing');
    const intent = await parseIntent(text);

    switch (intent.action) {

      case 'save': {
        if (!intent.service || !intent.password) {
          return bot.sendMessage(chatId,
            `❓ No he entendido bien.\n\nEjemplo: _guarda netflix: usuario@email.com / MiClave123_`,
            { parse_mode: 'Markdown' }
          );
        }
        const encPass = encrypt(intent.password, MASTER_KEY);
        const encUser = intent.username ? encrypt(intent.username, MASTER_KEY) : null;
        const encNotes = intent.notes ? encrypt(intent.notes, MASTER_KEY) : null;
        const result = await savePassword(intent.service, encUser, encPass, encNotes);

        const isUpdate = result === 'updated';
        return bot.sendMessage(chatId,
          `${isUpdate ? '🔄' : '✅'} *${intent.service}* ${isUpdate ? 'actualizado' : 'guardado'} correctamente.\n` +
          `${intent.username ? `👤 \`${intent.username}\`\n` : ''}` +
          `🔒 \`${'•'.repeat(Math.min(intent.password.length, 12))}\``,
          { parse_mode: 'Markdown' }
        );
      }

      case 'get': {
        if (!intent.service) {
          return bot.sendMessage(chatId, '❓ ¿De qué servicio quieres la contraseña?');
        }
        const record = await getPassword(intent.service);
        if (!record) {
          return bot.sendMessage(chatId,
            `❌ No tengo nada guardado para *${intent.service}*.\n_¿Quizás con otro nombre?_`,
            { parse_mode: 'Markdown' }
          );
        }
        const pass = decrypt(record.password, MASTER_KEY);
        const user = record.username ? decrypt(record.username, MASTER_KEY) : null;
        const notes = record.notes ? decrypt(record.notes, MASTER_KEY) : null;

        let response = `🔑 *${record.service}*\n`;
        if (user) response += `👤 \`${user}\`\n`;
        response += `🔒 \`${pass}\``;
        if (notes) response += `\n📝 ${notes}`;
        response += `\n\n⏱ _Este mensaje se borrará en 45s_`;

        return sendSecret(chatId, response);
      }

      case 'list':
        return handleList(chatId);

      case 'delete': {
        if (!intent.service) {
          return bot.sendMessage(chatId, '❓ ¿Qué servicio quieres borrar?');
        }
        const record = await getPassword(intent.service);
        if (!record) {
          return bot.sendMessage(chatId,
            `❌ No encontré *${intent.service}*.`,
            { parse_mode: 'Markdown' }
          );
        }
        return bot.sendMessage(chatId,
          `⚠️ ¿Seguro que quieres eliminar *${record.service}*?`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '🗑️ Sí, borrar', callback_data: `del_confirm:${record.service}` },
                { text: '↩️ Cancelar', callback_data: `del_cancel:${record.service}` }
              ]]
            }
          }
        );
      }

      case 'generate': {
        const length = Math.min(Math.max(intent.length || 16, 8), 64);
        const pwd = generatePassword(length);
        return sendSecret(chatId,
          `🎲 *Contraseña generada* (${length} caracteres)\n\n\`${pwd}\`\n\n⏱ _Este mensaje se borrará en 45s_`
        );
      }

      default:
        return bot.sendMessage(chatId,
          `❓ No he entendido. Puedo:\n• *Guardar* credenciales\n• *Consultar* contraseñas\n• *Listar* servicios\n• *Borrar* entradas\n• *Generar* contraseñas seguras\n\nEscribe /start para ver ejemplos.`,
          { parse_mode: 'Markdown' }
        );
    }

  } catch (err) {
    console.error('Error:', err);
    bot.sendMessage(chatId, '⚠️ Algo ha fallado, inténtalo de nuevo.');
  }
});

console.log('🤖 Pass-bot iniciado y escuchando...');
