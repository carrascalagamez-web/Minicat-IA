
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const Groq = require("groq-sdk");
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder
} = require("discord.js");

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ==================================================
// INICIO Y CONFIGURACIÓN
// ==================================================

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG = require("./config.json");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.Channel,
    Partials.Message
  ]
});

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "database.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DEFAULT_DB = {
  users: {},
  conversations: {},
  memories: {},
  preferences: {},
  usage: {},
  sessions: {},
  statistics: {
    totalUsers: 0,
    totalMessages: 0,
    totalImages: 0
  },
  lastUpdated: null
};

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(DEFAULT_DB, null, 2)
  );
}

function readDB() {
  const data = JSON.parse(
    fs.readFileSync(DB_FILE, "utf8")
  );

  return {
    ...DEFAULT_DB,
    ...data,
    statistics: {
      ...DEFAULT_DB.statistics,
      ...(data.statistics || {})
    }
  };
}

function saveDB(db) {
  db.lastUpdated = new Date().toISOString();

  const temp = DB_FILE + ".tmp";

  fs.writeFileSync(
    temp,
    JSON.stringify(db, null, 2)
  );

  fs.renameSync(temp, DB_FILE);
}

function ensureUser(userId) {
  const db = readDB();
  const id = String(userId);

  if (!db.users[id]) {
    db.users[id] = {
      id,
      plan: "free",
      createdAt: new Date().toISOString()
    };

    db.statistics.totalUsers++;
    saveDB(db);
  }

  return db.users[id];
}

// ==================================================
// USUARIOS Y LÍMITES
// ==================================================

function getPlanLimits(plan) {
  const limits = CONFIG.limits || {};

  return limits[plan] || limits.free || {
    messagesPerDay: 100,
    imagesPerDay: 5
  };
}

function getTodayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.app?.timezone || "America/Bogota"
  }).format(new Date());
}

function getUsage(userId) {
  const db = readDB();
  const id = String(userId);
  const today = getTodayKey();

  if (!db.usage[id] || db.usage[id].date !== today) {
    db.usage[id] = {
      date: today,
      messages: 0,
      images: 0
    };

    saveDB(db);
  }

  return db.usage[id];
}

function canUse(userId, type) {
  const db = readDB();
  const user = ensureUser(userId);
  const usage = getUsage(userId);
  const limits = getPlanLimits(user.plan);

  const key = type === "image" ? "images" : "messages";
  const limitKey = type === "image"
    ? "imagesPerDay"
    : "messagesPerDay";

  return usage[key] < limits[limitKey];
}

function addUsage(userId, type) {
  const db = readDB();
  const usage = getUsage(userId);

  if (type === "image") {
    usage.images++;
  } else {
    usage.messages++;
  }

  saveDB(db);
}

// ==================================================
// CONVERSACIONES
// ==================================================

function getConversations(userId) {
  const db = readDB();

  return db.conversations[String(userId)] || [];
}

function getConversation(userId, chatId) {
  return getConversations(userId).find(
    chat => chat.id === chatId
  );
}

function createConversation(userId, title = "Nuevo chat") {
  const db = readDB();
  const id = String(userId);

  if (!db.conversations[id]) {
    db.conversations[id] = [];
  }

  const chat = {
    id: crypto.randomUUID(),
    title,
    messages: [],
    archived: false,
    pinned: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.conversations[id].unshift(chat);
  saveDB(db);

  return chat;
}

function addConversationMessage(
  userId,
  chatId,
  role,
  content
) {
  const db = readDB();
  const chats = db.conversations[String(userId)] || [];

  const chat = chats.find(item => item.id === chatId);

  if (!chat) {
    throw new Error("Conversación no encontrada.");
  }

  chat.messages.push({
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString()
  });

  if (chat.messages.length === 1) {
    chat.title = content.slice(0, 45);
  }

  chat.updatedAt = new Date().toISOString();

  db.statistics.totalMessages++;
  saveDB(db);

  return chat;
}

function deleteConversation(userId, chatId) {
  const db = readDB();
  const id = String(userId);

  db.conversations[id] =
    (db.conversations[id] || []).filter(
      chat => chat.id !== chatId
    );

  saveDB(db);
}

function updateConversation(userId, chatId, changes) {
  const db = readDB();
  const chats = db.conversations[String(userId)] || [];

  const chat = chats.find(item => item.id === chatId);

  if (!chat) return null;

  if (typeof changes.title === "string") {
    chat.title = changes.title.slice(0, 100);
  }

  if (typeof changes.archived === "boolean") {
    chat.archived = changes.archived;
  }

  if (typeof changes.pinned === "boolean") {
    chat.pinned = changes.pinned;
  }

  chat.updatedAt = new Date().toISOString();

  saveDB(db);

  return chat;
}

// ==================================================
// PREFERENCIAS Y MEMORIA
// ==================================================

function getPreferences(userId) {
  const db = readDB();

  return db.preferences[String(userId)] || {
    language: "es",
    memoryEnabled: true,
    responseStyle: "normal"
  };
}

function updatePreferences(userId, changes) {
  const db = readDB();
  const id = String(userId);

  db.preferences[id] = {
    ...getPreferences(userId),
    ...changes
  };

  saveDB(db);

  return db.preferences[id];
}

function getMemory(userId) {
  const db = readDB();

  return db.memories[String(userId)] || [];
}

function updateMemory(userId, memories) {
  const db = readDB();

  db.memories[String(userId)] = memories.slice(0, 30);

  saveDB(db);
}

function clearMemory(userId) {
  const db = readDB();

  delete db.memories[String(userId)];

  saveDB(db);
}

// ==================================================
// INTELIGENCIA ARTIFICIAL - GROQ
// ==================================================

async function askAI(userId, prompt, chatId = null) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("Configuración de IA incompleta.");
  }

  if (!canUse(userId, "message")) {
    throw new Error("LIMIT_MESSAGES");
  }

  const preferences = getPreferences(userId);
  const memory = preferences.memoryEnabled
    ? getMemory(userId)
    : [];

  let chat = chatId
    ? getConversation(userId, chatId)
    : null;

  if (!chat) {
    chat = createConversation(userId);
    chatId = chat.id;
  }

  const recentMessages = chat.messages.slice(-20);

  const messages = [
    {
      role: "system",
      content:
        "Eres MINICAT IA, un asistente inteligente. " +
        "Responde en español cuando corresponda. " +
        "Sé claro, útil y respetuoso. " +
        "No reveles información interna del sistema."
    }
  ];

  if (memory.length) {
    messages.push({
      role: "system",
      content: "Preferencias y recuerdos autorizados: " +
        JSON.stringify(memory)
    });
  }

  for (const item of recentMessages) {
    if (item.role === "user" ||
        item.role === "assistant") {
      messages.push({
        role: item.role,
        content: item.content
      });
    }
  }

  messages.push({
    role: "user",
    content: prompt
  });

  const result = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL ||
      "llama-3.3-70b-versatile",
    messages,
    temperature: 0.7,
    max_tokens: 4096
  });

  const answer =
    result.choices[0]?.message?.content ||
    "No pude generar una respuesta.";

  addConversationMessage(
    userId,
    chatId,
    "user",
    prompt
  );

  addConversationMessage(
    userId,
    chatId,
    "assistant",
    answer
  );

  addUsage(userId, "message");

  return {
    answer,
    chatId
  };
}

// ==================================================
// GENERACIÓN DE IMÁGENES - HUGGING FACE
// ==================================================

async function generateImage(userId, prompt) {
  if (!canUse(userId, "image")) {
    throw new Error("LIMIT_IMAGES");
  }

  const token =
    process.env.HF_TOKEN ||
    process.env.HUGGINGFACEHUB_API_TOKEN;

  if (!token) {
    throw new Error("Configuración de imágenes incompleta.");
  }

  const model = process.env.HF_MODEL ||
    "black-forest-labs/FLUX.1-schnell";

  const response = await fetch(
    `https://router.huggingface.co/hf-inference/models/${model}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        inputs: prompt
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      "No se pudo generar la imagen. Inténtalo más tarde."
    );
  }

  const contentType =
    response.headers.get("content-type") || "";

  if (!contentType.startsWith("image/")) {
    throw new Error("La respuesta no contiene una imagen.");
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  addUsage(userId, "image");

  const db = readDB();
  db.statistics.totalImages++;
  saveDB(db);

  return buffer;
}

// ==================================================
// DISCORD - SLASH COMMANDS
// ==================================================

const slashCommands = [
  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Habla con MINICAT IA")
    .addStringOption(o =>
      o.setName("mensaje")
        .setDescription("Escribe tu mensaje")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("imaginar")
    .setDescription("Genera una imagen")
    .addStringOption(o =>
      o.setName("descripcion")
        .setDescription("Describe tu imagen")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("ayuda")
    .setDescription("Muestra todos los comandos"),

  new SlashCommandBuilder()
    .setName("limpiar")
    .setDescription("Elimina tu conversación actual"),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Comprueba la conexión"),

  new SlashCommandBuilder()
    .setName("memoria")
    .setDescription("Administra tu memoria personal")
    .addSubcommand(s =>
      s.setName("ver")
        .setDescription("Ver tus recuerdos guardados")
    )
    .addSubcommand(s =>
      s.setName("limpiar")
        .setDescription("Borrar tus recuerdos")
    ),

  new SlashCommandBuilder()
    .setName("preferencias")
    .setDescription("Consulta tus preferencias")
].map(command => command.toJSON());

async function registerSlashCommands() {
  if (!process.env.DISCORD_TOKEN ||
      !process.env.DISCORD_CLIENT_ID) {
    return;
  }

  const rest = new REST({ version: "10" })
    .setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationCommands(
      process.env.DISCORD_CLIENT_ID
    ),
    { body: slashCommands }
  );

  console.log("Comandos de Discord registrados.");
}

// ==================================================
// DISCORD - RESPUESTAS
// ==================================================

async function replyLong(message, text) {
  const chunks = text.match(/[\s\S]{1,1900}/g) || [];

  for (const chunk of chunks) {
    await message.reply({
      content: chunk,
      allowedMentions: {
        repliedUser: false
      }
    });
  }
}

async function discordChat(message, prompt) {
  try {
    await message.channel.sendTyping();

    const result = await askAI(
      message.author.id,
      prompt
    );

    await replyLong(message, result.answer);
  } catch (error) {
    console.error("Discord AI:", error);

    const messageError =
      error.message === "LIMIT_MESSAGES"
        ? "Has alcanzado tu límite diario de mensajes."
        : "No pude responder en este momento.";

    await message.reply(messageError);
  }
}

async function discordImage(message, prompt) {
  try {
    await message.channel.sendTyping();

    const image = await generateImage(
      message.author.id,
      prompt
    );

    await message.reply({
      content: "¡Tu imagen está lista!",
      files: [
        new AttachmentBuilder(image, {
          name: "minicat-imagen.png"
        })
      ]
    });
  } catch (error) {
    console.error("Discord image:", error);

    await message.reply(
      error.message === "LIMIT_IMAGES"
        ? "Has alcanzado tu límite diario de imágenes."
        : "No pude generar esa imagen."
    );
  }
}

// ==================================================
// DISCORD - PREFIJO, MENCIÓN Y RESPUESTAS
// ==================================================

client.on("messageCreate", async message => {
  if (message.author.bot || !client.user) return;

  const content = message.content.trim();

  const mentionPattern = new RegExp(
    `<@!?${client.user.id}>`,
    "g"
  );

  const mentioned = message.mentions.has(client.user);

  let repliedToBot = false;

  if (message.reference?.messageId) {
    const referenced = await message.channel.messages.fetch(
      message.reference.messageId
    ).catch(() => null);

    repliedToBot =
      referenced?.author?.id === client.user.id;
  }

  const prefixCommand = content.startsWith(".");
  const mentionMessage = mentioned;
  const replyMessage = repliedToBot;

  if (!prefixCommand && !mentionMessage && !replyMessage) {
    return;
  }

  let prompt = content;

  if (mentionMessage) {
    prompt = prompt.replace(mentionPattern, "").trim();
  }

  if (prefixCommand) {
    const [command, ...args] = content.slice(1)
      .trim()
      .split(/\s+/);

    prompt = args.join(" ");

    switch (command.toLowerCase()) {
      case "ayuda":
        return message.reply(
          "**MINICAT IA**\n" +
          "`.chat mensaje` — Conversar\n" +
          "`.imaginar descripción` — Crear imagen\n" +
          "`.limpiar` — Limpiar chat\n" +
          "`.memoria` — Administrar memoria\n" +
          "`.ping` — Latencia\n" +
          "`.ayuda` — Ayuda"
        );

      case "ping":
        return message.reply(
          `Pong: ${client.ws.ping} ms`
        );

      case "limpiar": {
        const db = readDB();
        delete db.conversations[message.author.id];
        saveDB(db);

        return message.reply("Conversación eliminada.");
      }

      case "imaginar":
        if (!prompt) {
          return message.reply(
            "Describe la imagen que deseas generar."
          );
        }

        return discordImage(message, prompt);

      case "chat":
      case "preguntar":
        if (!prompt) {
          return message.reply(
            "Escribe un mensaje para MINICAT IA."
          );
        }

        return discordChat(message, prompt);

      case "memoria":
        return message.reply(
          "Usa `/memoria ver` o `/memoria limpiar`."
        );

      default:
        return;
    }
  }

  if (!prompt && !replyMessage) {
    return message.reply(
      "¡Hola! ¿En qué puedo ayudarte?"
    );
  }

  if (prompt) {
    await discordChat(message, prompt);
  }
});

// ==================================================
// DISCORD - INTERACCIONES SLASH
// ==================================================

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = interaction.commandName;
  const userId = interaction.user.id;

  try {
    if (command === "ayuda") {
      return interaction.reply({
        ephemeral: true,
        content:
          "**MINICAT IA**\n" +
          "`/chat` — Conversar\n" +
          "`/imaginar` — Generar imagen\n" +
          "`/limpiar` — Eliminar conversación\n" +
          "`/memoria` — Administrar memoria\n" +
          "`/preferencias` — Ver preferencias\n" +
          "`/ping` — Latencia"
      });
    }

    if (command === "ping") {
      return interaction.reply({
        content: `Pong: ${client.ws.ping} ms`,
        ephemeral: true
      });
    }

    if (command === "limpiar") {
      const db = readDB();
      delete db.conversations[userId];
      saveDB(db);

      return interaction.reply({
        content: "Tu historial ha sido eliminado.",
        ephemeral: true
      });
    }

    if (command === "preferencias") {
      return interaction.reply({
        content:
          "Tus preferencias:\n```json\n" +
          JSON.stringify(getPreferences(userId), null, 2) +
          "\n```",
        ephemeral: true
      });
    }

    if (command === "memoria") {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === "ver") {
        return interaction.reply({
          content: JSON.stringify(
            getMemory(userId),
            null,
            2
          ).slice(0, 1900) || "No tienes recuerdos guardados.",
          ephemeral: true
        });
      }

      if (subcommand === "limpiar") {
        clearMemory(userId);

        return interaction.reply({
          content: "Tu memoria personal ha sido eliminada.",
          ephemeral: true
        });
      }
    }

    if (command === "chat") {
      const prompt = interaction.options.getString("mensaje");

      await interaction.deferReply();

      const result = await askAI(userId, prompt);

      await interaction.editReply(result.answer.slice(0, 2000));

      return;
    }

    if (command === "imaginar") {
      const prompt = interaction.options.getString("descripcion");

      await interaction.deferReply();

      const image = await generateImage(userId, prompt);

      await interaction.editReply({
        content: "¡Tu imagen está lista!",
        files: [
          new AttachmentBuilder(image, {
            name: "minicat-imagen.png"
          })
        ]
      });
    }
  } catch (error) {
    console.error("Interacción:", error);

    const response = {
      content:
        error.message === "LIMIT_MESSAGES"
          ? "Has alcanzado tu límite de mensajes."
          : error.message === "LIMIT_IMAGES"
            ? "Has alcanzado tu límite de imágenes."
            : "Ha ocurrido un error. Inténtalo nuevamente.",
      ephemeral: true
    };

    if (interaction.deferred) {
      await interaction.editReply(response);
    } else if (interaction.replied) {
      await interaction.followUp(response);
    } else {
      await interaction.reply(response);
    }
  }
});

// ==================================================
// EXPRESS - WEB
// ==================================================

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: "minicat.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(express.static(
  path.join(__dirname, "public")
));

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Inicia sesión con Discord."
    });
  }

  next();
}

// ==================================================
// DISCORD OAUTH
// ==================================================

app.get("/auth/discord", (req, res) => {
  const state = crypto.randomBytes(24).toString("hex");

  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state
  });

  res.redirect(
    `https://discord.com/oauth2/authorize?${params.toString()}`
  );
});

// ==================================================
// DISCORD OAUTH CALLBACK
// ==================================================

app.get("/auth/discord/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (
      !code ||
      !state ||
      !req.session.oauthState ||
      state !== req.session.oauthState
    ) {
      return res.status(400).send(
        "La autenticación no es válida. Inténtalo nuevamente."
      );
    }

    delete req.session.oauthState;

    const tokenResponse = await fetch(
      "https://discord.com/api/v10/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: process.env.DISCORD_REDIRECT_URI
        })
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      throw new Error("No se pudo obtener el acceso de Discord.");
    }

    const userResponse = await fetch(
      "https://discord.com/api/v10/users/@me",
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`
        }
      }
    );

    const discordUser = await userResponse.json();

    if (!userResponse.ok || !discordUser.id) {
      throw new Error("No se pudo verificar tu cuenta.");
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate(error => {
        if (error) reject(error);
        else resolve();
      });
    });

    ensureUser(discordUser.id);

    req.session.user = {
      id: discordUser.id,
      username: discordUser.username,
      global_name: discordUser.global_name,
      avatar: discordUser.avatar
    };

    await new Promise((resolve, reject) => {
      req.session.save(error => {
        if (error) reject(error);
        else resolve();
      });
    });

    res.redirect("/");
  } catch (error) {
    console.error("Error OAuth Discord:", error);

    res.status(500).send(
      "No se pudo iniciar sesión con Discord."
    );
  }
});

 
// ==================================================
// SESIÓN Y AUTENTICACIÓN
// ==================================================

function requireLogin(req, res, next) {
  if (!req.session?.user?.id) {
    return res.status(401).json({
      success: false,
      error: "Debes iniciar sesión con Discord."
    });
  }

  next();
}

app.get("/api/me", (req, res) => {
  res.json({
    authenticated: Boolean(req.session?.user),
    user: req.session?.user || null
  });
});

app.post("/auth/logout", requireLogin, (req, res) => {
  req.session.destroy(error => {
    if (error) {
      return res.status(500).json({
        error: "No se pudo cerrar la sesión."
      });
    }

    res.clearCookie("minicat.sid");

    res.json({
      success: true,
      message: "Sesión cerrada."
    });
  });
});

// ==================================================
// PERFIL DEL USUARIO
// ==================================================

app.get("/api/profile", requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const db = readDB();
  const user = db.users[userId];

  res.json({
    profile: req.session.user,
    account: user,
    preferences: getPreferences(userId)
  });
});

// ==================================================
// ACTUALIZAR PREFERENCIAS
// ==================================================

app.patch("/api/preferences", requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const changes = {};

  if (typeof req.body.language === "string") {
    changes.language = req.body.language.slice(0, 10);
  }

  if (typeof req.body.memoryEnabled === "boolean") {
    changes.memoryEnabled = req.body.memoryEnabled;
  }

  if (typeof req.body.responseStyle === "string") {
    changes.responseStyle = req.body.responseStyle.slice(0, 30);
  }

  res.json({
    success: true,
    preferences: updatePreferences(userId, changes)
  });
});


// ==================================================
// BIBLIOTECA DEL USUARIO
// ==================================================

app.get("/api/library", requireLogin, (req, res) => {
  const db = readDB();
  const userId = req.session.user.id;

  res.json({
    items: db.library?.[userId] || []
  });
});

app.delete(
  "/api/library/:imageId",
  requireLogin,
  (req, res) => {
    const db = readDB();
    const userId = req.session.user.id;

    if (!db.library) db.library = {};

    db.library[userId] =
      (db.library[userId] || []).filter(
        item => item.id !== req.params.imageId
      );

    saveDB(db);

    res.json({ success: true });
  }
);

// ==================================================
// GUARDAR IMAGEN GENERADA EN BIBLIOTECA
// ==================================================

function saveImageToLibrary(userId, buffer, prompt) {
  const db = readDB();

  if (!db.library) db.library = {};
  if (!db.library[userId]) db.library[userId] = [];

  const item = {
    id: crypto.randomUUID(),
    prompt,
    image: buffer.toString("base64"),
    createdAt: new Date().toISOString()
  };

  db.library[userId].unshift(item);

  db.library[userId] = db.library[userId].slice(0, 50);

  saveDB(db);

  return item;
}


// ==================================================
// GENERAR Y GUARDAR IMÁGENES
// ==================================================

app.post("/api/image", requireLogin, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const prompt = String(req.body.prompt || "").trim();

    if (!prompt || prompt.length > 2000) {
      return res.status(400).json({
        error: "Describe la imagen correctamente."
      });
    }

    const image = await generateImage(userId, prompt);

    const saved = saveImageToLibrary(
      userId,
      image,
      prompt
    );

    res.json({
      success: true,
      imageId: saved.id,
      image: `data:image/png;base64,${image.toString("base64")}`
    });

  } catch (error) {
    console.error("Generación de imagen:", error);

    res.status(
      error.message === "LIMIT_IMAGES" ? 429 : 500
    ).json({
      error:
        error.message === "LIMIT_IMAGES"
          ? "Has alcanzado tu límite de imágenes."
          : "No se pudo generar la imagen."
    });
  }
});


// ==================================================
// ESTADÍSTICAS DEL USUARIO
// ==================================================

app.get("/api/statistics", requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const db = readDB();

  const chats = db.conversations[userId] || [];
  const usage = getUsage(userId);

  res.json({
    totalChats: chats.length,
    totalMessages: chats.reduce(
      (total, chat) => total + chat.messages.length,
      0
    ),
    todayMessages: usage.messages,
    todayImages: usage.images
  });
});

// ==================================================
// ESTADO DEL SISTEMA
// ==================================================

app.get("/api/status", (req, res) => {
  res.json({
    application: "MINICAT IA",
    web: true,
    discord: client.isReady(),
    conversationAI: Boolean(process.env.GROQ_API_KEY),
    imageGeneration: Boolean(
      process.env.HF_TOKEN ||
      process.env.HUGGINGFACEHUB_API_TOKEN
    )
  });
});

// ==================================================
// COMPROBACIÓN DEL SERVIDOR
// ==================================================

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "online",
    name: "MINICAT IA",
    timestamp: new Date().toISOString()
  });
});


// ==================================================
// PANEL DEL PROPIETARIO
// ==================================================

function requireOwner(req, res, next) {
  if (!req.session?.user?.id ||
      req.session.user.id !== process.env.OWNER_DISCORD_ID) {
    return res.status(403).json({
      error: "No tienes permiso para acceder."
    });
  }

  next();
}

app.get(
  "/api/owner/statistics",
  requireOwner,
  (req, res) => {
    const db = readDB();

    res.json({
      users: db.statistics.totalUsers,
      messages: db.statistics.totalMessages,
      images: db.statistics.totalImages,
      discord: client.isReady(),
      uptime: process.uptime()
    });
  }
);

app.get(
  "/api/owner/users",
  requireOwner,
  (req, res) => {
    const db = readDB();

    res.json({
      users: Object.values(db.users).map(user => ({
        id: user.id,
        plan: user.plan,
        createdAt: user.createdAt
      }))
    });
  }
);


// ==================================================
// RUTAS NO ENCONTRADAS
// ==================================================

app.use((req, res) => {
  res.status(404).json({
    error: "Ruta no encontrada."
  });
});

// ==================================================
// MANEJO DE ERRORES
// ==================================================

app.use((error, req, res, next) => {
  console.error("Error interno:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: "Error interno del servidor."
  });
});

// ==================================================
// INICIAR MINICAT IA
// ==================================================

const server = app.listen(PORT, () => {
  console.log("MINICAT IA WEB CONECTADA");
  console.log(`Puerto: ${PORT}`);
});

client.once("ready", () => {
  console.log(`MINICAT IA CONECTADO: ${client.user.tag}`);
});

if (process.env.DISCORD_TOKEN) {
  client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error("Error al conectar Discord:", error);
  });
}

process.on("SIGTERM", () => {
  console.log("Cerrando MINICAT IA...");

  client.destroy();

  server.close(() => {
    process.exit(0);
  });
});


