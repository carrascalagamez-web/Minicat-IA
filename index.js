
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Groq = require("groq-sdk");

const {
  Client,
  GatewayIntentBits,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  PermissionFlagsBits,
  AttachmentBuilder,
  EmbedBuilder
} = require("discord.js");

// =====================================
// CONFIGURACIÓN
// =====================================

const app = express();
const PORT = process.env.PORT || 3000;
const PREFIX = ".";

const PUBLIC_PATH = path.join(__dirname, "public");
const LOGO_PATH = path.join(
  PUBLIC_PATH,
  "Screenshot_20261101_141227_Discord.jpg"
);

const DATA_PATH = path.resolve(
  process.env.DATA_PATH || "./data/database.json"
);

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

if (!process.env.SESSION_SECRET) {
  console.error("Falta SESSION_SECRET.");
  process.exit(1);
}

// =====================================
// BASE DE DATOS
// =====================================

fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });

if (!fs.existsSync(DATA_PATH)) {
  fs.writeFileSync(DATA_PATH, JSON.stringify({
    users: {},
    conversations: {},
    servers: {},
    limits: {},
    statistics: {},
    warnings: {},
    settings: {
      language: "es",
      timezone: "America/Bogota",
      freeMessages: 100,
      webImages: 2,
      discordImages: 5,
      resetHours: 24
    }
  }, null, 2));
}

function readDatabase() {
  const database = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

  for (const key of [
    "users",
    "conversations",
    "servers",
    "limits",
    "statistics",
    "warnings"
  ]) {
    if (!database[key]) database[key] = {};
  }

  return database;
}

function saveDatabase(database) {
  const temporaryPath = DATA_PATH + ".tmp";

  fs.writeFileSync(
    temporaryPath,
    JSON.stringify(database, null, 2)
  );

  fs.renameSync(temporaryPath, DATA_PATH);
}

// =====================================
// EXPRESS Y SESIONES
// =====================================

app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
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

function requireLogin(req, res, next) {
  if (!req.session.user) {
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({
        error: "Inicia sesión con Discord."
      });
    }

    return res.redirect("/");
  }

  next();
}

// =====================================
// DISCORD OAUTH2
// =====================================

app.get("/auth/discord", (req, res) => {
  const {
    DISCORD_CLIENT_ID,
    DISCORD_REDIRECT_URI
  } = process.env;

  if (!DISCORD_CLIENT_ID || !DISCORD_REDIRECT_URI) {
    return res.status(500).send(
      "El inicio de sesión no está configurado."
    );
  }

  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
    state
  });

  res.redirect(
    "https://discord.com/oauth2/authorize?" + params.toString()
  );
});

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
        "No se pudo verificar el inicio de sesión."
      );
    }

    delete req.session.oauthState;

    const tokenResponse = await fetch(
      "https://discord.com/api/oauth2/token",
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
      throw new Error("Discord no pudo autorizar la cuenta.");
    }

    const userResponse = await fetch(
      "https://discord.com/api/users/@me",
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`
        }
      }
    );

    const user = await userResponse.json();

    if (!userResponse.ok || !user.id) {
      throw new Error("No se pudo obtener el usuario.");
    }

    const account = {
      id: user.id,
      username: user.username,
      globalName: user.global_name || user.username,
      avatar: user.avatar
    };

    const database = readDatabase();

    database.users[user.id] = {
      ...account,
      lastLogin: new Date().toISOString()
    };

    saveDatabase(database);

    req.session.regenerate(error => {
      if (error) {
        console.error(error);
        return res.status(500).send("Error iniciando sesión.");
      }

      req.session.user = account;

      req.session.save(saveError => {
        if (saveError) {
          console.error(saveError);
          return res.status(500).send("Error guardando sesión.");
        }

        res.redirect("/chat");
      });
    });

  } catch (error) {
    console.error("Error OAuth2:", error.message);
    res.status(500).send(
      "No se pudo iniciar sesión con Discord."
    );
  }
});

// =====================================
// PÁGINAS
// =====================================

app.get("/", (req, res) => {
  if (req.session.user) {
    return res.redirect("/chat");
  }

  res.sendFile(path.join(PUBLIC_PATH, "index.html"));
});

app.get("/chat", requireLogin, (req, res) => {
  res.sendFile(path.join(PUBLIC_PATH, "chat.html"));
});

app.get("/api/me", requireLogin, (req, res) => {
  res.json({
    authenticated: true,
    user: req.session.user
  });
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(error => {
    if (error) {
      return res.status(500).json({
        error: "No se pudo cerrar sesión."
      });
    }

    res.clearCookie("minicat.sid");
    res.json({ success: true });
  });
});

app.get("/chat.html", (req, res) => {
  res.redirect("/chat");
});

// =====================================
// ARCHIVOS PÚBLICOS Y LOGO
// =====================================

app.get("/logo", (req, res) => {
  if (!fs.existsSync(LOGO_PATH)) {
    return res.status(404).send("No se encontró el logo.");
  }

  res.sendFile(LOGO_PATH);
});

app.use(express.static(PUBLIC_PATH, {
  index: false
}));

// =====================================
// INTELIGENCIA ARTIFICIAL
// =====================================

async function askMinicat(
  userId,
  conversationId,
  question,
  guildId = null
) {
  if (!groq) {
    throw new Error("IA_NOT_CONFIGURED");
  }

  const database = readDatabase();

  if (!database.conversations[conversationId]) {
    database.conversations[conversationId] = {
      userId,
      messages: []
    };
  }

  const conversation = database.conversations[conversationId];

  if (conversation.userId !== userId) {
    throw new Error("CONVERSATION_ACCESS_DENIED");
  }

  const previousMessages = [...conversation.messages];

  conversation.messages.push({
    role: "user",
    content: question
  });

  conversation.messages = conversation.messages.slice(-12);

  const language = guildId
    ? database.servers[guildId]?.language || "español colombiano"
    : "español colombiano";

  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            `Eres MINICAT IA. Responde en ${language}, ` +
            "de forma clara, natural y útil. " +
            "No reveles proveedores ni detalles internos."
        },
        ...conversation.messages
      ],
      max_completion_tokens: 1200
    });

    const answer =
      completion.choices?.[0]?.message?.content?.trim();

    if (!answer) {
      throw new Error("Respuesta vacía.");
    }

    conversation.messages.push({
      role: "assistant",
      content: answer
    });

    conversation.messages = conversation.messages.slice(-12);

    saveDatabase(database);
    return answer;

  } catch (error) {
    conversation.messages = previousMessages;
    saveDatabase(database);
    throw error;
  }
}

// =====================================
// API DEL CHAT WEB
// =====================================

app.post("/api/chat", requireLogin, async (req, res) => {
  try {
    const message = String(req.body.message || "").trim();

    if (!message || message.length > 5000) {
      return res.status(400).json({
        error: "Escribe un mensaje de hasta 5000 caracteres."
      });
    }

    const userId = req.session.user.id;

    let conversationId = String(
      req.body.conversationId || ""
    );

    if (!conversationId) {
      conversationId = `web:${userId}:${crypto.randomUUID()}`;
    }

    if (!conversationId.startsWith(`web:${userId}:`)) {
      return res.status(403).json({
        error: "Conversación no autorizada."
      });
    }

    const answer = await askMinicat(
      userId,
      conversationId,
      message
    );

    const database = readDatabase();

    res.json({
      success: true,
      conversationId,
      message: answer,
      messages: database.conversations[conversationId].messages
    });

  } catch (error) {
    console.error("Error en API chat:", error.message);

    res.status(500).json({
      error: "No se pudo obtener una respuesta."
    });
  }
});

// =====================================
// LISTA Y CARGA DE CHATS
// =====================================

app.get("/api/chats", requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const database = readDatabase();

  const chats = Object.entries(database.conversations)
    .filter(([id, conversation]) =>
      id.startsWith(`web:${userId}:`) &&
      conversation.userId === userId
    )
    .map(([id, conversation]) => ({
      id,
      title: conversation.messages.find(
        message => message.role === "user"
      )?.content?.slice(0, 45) || "Nuevo chat"
    }));

  res.json({ chats });
});

app.get("/api/chat/:id", requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const conversationId = req.params.id;

  if (!conversationId.startsWith(`web:${userId}:`)) {
    return res.status(403).json({
      error: "Conversación no autorizada."
    });
  }

  const database = readDatabase();
  const conversation = database.conversations[conversationId];

  if (!conversation || conversation.userId !== userId) {
    return res.status(404).json({
      error: "Conversación no encontrada."
    });
  }

  res.json({
    success: true,
    conversationId,
    messages: conversation.messages
  });
});

// =====================================
// GENERACIÓN DE IMÁGENES
// =====================================

async function generateImageBuffer(prompt) {
  const apiKey = process.env.IMAGE_API_KEY;
  const apiUrl = process.env.IMAGE_API_URL;

  if (!apiKey || !apiUrl) {
    throw new Error("IMAGE_PROVIDER_NOT_CONFIGURED");
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "image/png"
    },
    body: JSON.stringify({
      inputs: prompt,
      options: { wait_for_model: true }
    })
  });

  if (!response.ok) {
    throw new Error(`IMAGE_API_ERROR_${response.status}`);
  }

  const type = response.headers.get("content-type") || "";

  if (!type.startsWith("image/")) {
    throw new Error("Respuesta de imagen inválida.");
  }

  return Buffer.from(await response.arrayBuffer());
}

app.post("/api/image", requireLogin, async (req, res) => {
  try {
    const prompt = String(req.body.prompt || "").trim();

    if (!prompt || prompt.length > 1000) {
      return res.status(400).json({
        error: "Describe la imagen (máximo 1000 caracteres)."
      });
    }

    const buffer = await generateImageBuffer(prompt);

    res.json({
      success: true,
      image: `data:image/png;base64,${buffer.toString("base64")}`
    });

  } catch (error) {
    console.error("Error de imagen:", error.message);

    res.status(500).json({
      error: "No se pudo generar la imagen."
    });
  }
});

// =====================================
// CLIENTE DISCORD
// =====================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ]
});

function getConversationId(guildId, channelId, userId) {
  return `discord:${guildId}:${channelId}:${userId}`;
}

function isModerator(member) {
  return member.permissions.has(
    PermissionFlagsBits.ModerateMembers
  ) || member.permissions.has(
    PermissionFlagsBits.Administrator
  );
}

function isAdministrator(member) {
  return member.permissions.has(
    PermissionFlagsBits.Administrator
  );
}

async function replyLong(message, content) {
  const chunks = content.match(/[\s\S]{1,1900}/g) || [];

  for (let index = 0; index < chunks.length; index++) {
    if (index === 0) {
      await message.reply(chunks[index]);
    } else {
      await message.channel.send(chunks[index]);
    }
  }
}

async function runAI(userId, guildId, channelId, question) {
  return askMinicat(
    userId,
    getConversationId(guildId, channelId, userId),
    question,
    guildId
  );
}

// =====================================
// COMANDOS SLASH
// =====================================

const slashCommands = [
  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Habla con MINICAT IA")
    .addStringOption(option =>
      option.setName("mensaje")
        .setDescription("Tu mensaje")
        .setRequired(true)
        .setMaxLength(1500)
    ),

  new SlashCommandBuilder()
    .setName("imagine")
    .setDescription("Genera una imagen")
    .addStringOption(option =>
      option.setName("descripcion")
        .setDescription("Describe la imagen")
        .setRequired(true)
        .setMaxLength(1000)
    ),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Comprueba la conexión"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Muestra los comandos"),

  new SlashCommandBuilder()
    .setName("resumir")
    .setDescription("Resume un texto")
    .addStringOption(option =>
      option.setName("texto").setDescription("Texto").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("traducir")
    .setDescription("Traduce un texto")
    .addStringOption(option =>
      option.setName("texto").setDescription("Texto").setRequired(true)
    )
    .addStringOption(option =>
      option.setName("idioma").setDescription("Idioma").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("explicar")
    .setDescription("Explica un tema")
    .addStringOption(option =>
      option.setName("tema").setDescription("Tema").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Advierte a un usuario")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Usuario").setRequired(true)
    )
    .addStringOption(option =>
      option.setName("razon").setDescription("Razón").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("Consulta advertencias")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Usuario").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Elimina mensajes recientes")
    .addIntegerOption(option =>
      option.setName("cantidad")
        .setDescription("Cantidad")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100)
    ),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Expulsa a un usuario")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Usuario").setRequired(true)
    )
    .addStringOption(option =>
      option.setName("razon").setDescription("Razón")
    ),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Banea a un usuario")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Usuario").setRequired(true)
    )
    .addStringOption(option =>
      option.setName("razon").setDescription("Razón")
    ),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Aplica tiempo de espera")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Usuario").setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName("minutos")
        .setDescription("Minutos")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(40320)
    ),

  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Bloquea el canal"),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Desbloquea el canal"),

  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configuración del servidor"),

  new SlashCommandBuilder()
    .setName("language")
    .setDescription("Cambia el idioma")
    .addStringOption(option =>
      option.setName("idioma")
        .setDescription("Idioma")
        .setRequired(true)
        .addChoices(
          { name: "Español", value: "español colombiano" },
          { name: "Inglés", value: "inglés" }
        )
    ),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Información de usuario")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Usuario")
    ),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Información del servidor"),

  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Muestra un avatar")
    .addUserOption(option =>
      option.setName("usuario").setDescription("Usuario")
    ),

  new SlashCommandBuilder()
    .setName("poll")
    .setDescription("Crea una encuesta")
    .addStringOption(option =>
      option.setName("pregunta").setDescription("Pregunta").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("suggest")
    .setDescription("Envía una sugerencia")
    .addStringOption(option =>
      option.setName("texto").setDescription("Sugerencia").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Pregunta a la bola mágica")
    .addStringOption(option =>
      option.setName("pregunta").setDescription("Pregunta").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("Lanza una moneda"),

  new SlashCommandBuilder()
    .setName("dice")
    .setDescription("Lanza un dado"),

  new SlashCommandBuilder()
    .setName("joke")
    .setDescription("Cuenta un chiste"),

  new SlashCommandBuilder()
    .setName("fact")
    .setDescription("Dato curioso")
];

// =====================================
// REGISTRO DE COMANDOS
// =====================================

async function registerCommands() {
  if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CLIENT_ID) {
    console.warn("No se registraron comandos: faltan credenciales.");
    return;
  }

  const rest = new REST({ version: "10" })
    .setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
    {
      body: slashCommands.map(command => command.toJSON())
    }
  );

  console.log("Comandos slash registrados correctamente.");
}

// =====================================
// INTERACCIONES SLASH
// =====================================

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;

  try {
    if (name === "ping") {
      return interaction.reply(`🏓 Pong: ${client.ws.ping} ms`);
    }

    if (name === "help") {
      return interaction.reply({
        content: helpMessage(),
        ephemeral: true
      });
    }

    if (name === "chat") {
      await interaction.deferReply();

      const question = interaction.options.getString("mensaje");

      const answer = await runAI(
        interaction.user.id,
        interaction.guildId,
        interaction.channelId,
        question
      );

      return interaction.editReply(answer.slice(0, 2000));
    }

    if (name === "imagine") {
      await interaction.deferReply();

      const prompt = interaction.options.getString("descripcion");
      const buffer = await generateImageBuffer(prompt);

      return interaction.editReply({
        files: [
          new AttachmentBuilder(buffer, {
            name: "minicat-imagen.png"
          })
        ]
      });
    }

    if (name === "resumir" || name === "traducir" || name === "explicar") {
      await interaction.deferReply();

      let question = "";

      if (name === "resumir") {
        question = "Resume este texto:\n" +
          interaction.options.getString("texto");
      }

      if (name === "traducir") {
        question =
          `Traduce al idioma ${interaction.options.getString("idioma")}:\n` +
          interaction.options.getString("texto");
      }

      if (name === "explicar") {
        question =
          "Explícame este tema de forma clara: " +
          interaction.options.getString("tema");
      }

      const answer = await runAI(
        interaction.user.id,
        interaction.guildId,
        interaction.channelId,
        question
      );

      return interaction.editReply(answer.slice(0, 2000));
    }

    if (!interaction.guild || !interaction.memberPermissions) {
      return interaction.reply({
        content: "Este comando requiere un servidor.",
        ephemeral: true
      });
    }

    const member = interaction.member;
    const target = interaction.options.getMember("usuario");

    if (["warn", "warnings", "clear", "kick", "ban", "timeout", "lock", "unlock", "language"].includes(name)) {
      if (
        !member.permissions.has(PermissionFlagsBits.ModerateMembers) &&
        !member.permissions.has(PermissionFlagsBits.Administrator)
      ) {
        return interaction.reply({
          content: "No tienes permisos para este comando.",
          ephemeral: true
        });
      }
    }

    if (name === "warn") {
      const user = interaction.options.getUser("usuario");
      const reason = interaction.options.getString("razon");

      const database = readDatabase();

      if (!database.warnings[interaction.guildId]) {
        database.warnings[interaction.guildId] = {};
      }

      if (!database.warnings[interaction.guildId][user.id]) {
        database.warnings[interaction.guildId][user.id] = [];
      }

      database.warnings[interaction.guildId][user.id].push({
        moderatorId: interaction.user.id,
        reason,
        date: new Date().toISOString()
      });

      saveDatabase(database);

      return interaction.reply(
        `⚠️ ${user.tag} recibió una advertencia.\nRazón: ${reason}`
      );
    }

    if (name === "warnings") {
      const user = interaction.options.getUser("usuario");
      const warnings =
        readDatabase().warnings[interaction.guildId]?.[user.id] || [];

      return interaction.reply({
        content: warnings.length
          ? warnings.map((warning, index) =>
              `${index + 1}. ${warning.reason}`
            ).join("\n")
          : "Este usuario no tiene advertencias.",
        ephemeral: true
      });
    }

    if (name === "clear") {
      if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return interaction.reply({
          content: "Necesitas permiso para gestionar mensajes.",
          ephemeral: true
        });
      }

      const amount = interaction.options.getInteger("cantidad");
      await interaction.channel.bulkDelete(amount, true);

      return interaction.reply({
        content: `Se eliminaron ${amount} mensajes.`,
        ephemeral: true
      });
    }

    if (name === "kick") {
      if (!member.permissions.has(PermissionFlagsBits.KickMembers)) {
        return interaction.reply({
          content: "No tienes permiso para expulsar usuarios.",
          ephemeral: true
        });
      }

      if (!target?.kickable) {
        return interaction.reply({
          content: "No puedo expulsar a ese usuario.",
          ephemeral: true
        });
      }

      await target.kick(
        interaction.options.getString("razon") || "Sin razón"
      );

      return interaction.reply("Usuario expulsado.");
    }

    if (name === "ban") {
      if (!member.permissions.has(PermissionFlagsBits.BanMembers)) {
        return interaction.reply({
          content: "No tienes permiso para banear usuarios.",
          ephemeral: true
        });
      }

      if (!target?.bannable) {
        return interaction.reply({
          content: "No puedo banear a ese usuario.",
          ephemeral: true
        });
      }

      await target.ban({
        reason: interaction.options.getString("razon") || "Sin razón"
      });

      return interaction.reply("Usuario baneado.");
    }

    if (name === "timeout") {
      if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({
          content: "No tienes permiso para aplicar timeout.",
          ephemeral: true
        });
      }

      const minutes = interaction.options.getInteger("minutos");

      if (!target?.moderatable) {
        return interaction.reply({
          content: "No puedo moderar a ese usuario.",
          ephemeral: true
        });
      }

      await target.timeout(minutes * 60 * 1000);

      return interaction.reply(
        `Timeout aplicado durante ${minutes} minutos.`
      );
    }

    if (name === "lock" || name === "unlock") {
      if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.reply({
          content: "No tienes permiso para administrar canales.",
          ephemeral: true
        });
      }

      await interaction.channel.permissionOverwrites.edit(
        interaction.guild.roles.everyone,
        {
          SendMessages: name === "unlock"
        }
      );

      return interaction.reply(
        name === "lock" ? "🔒 Canal bloqueado." : "🔓 Canal desbloqueado."
      );
    }

    if (name === "language") {
      const language = interaction.options.getString("idioma");
      const database = readDatabase();

      if (!database.servers[interaction.guildId]) {
        database.servers[interaction.guildId] = {};
      }

      database.servers[interaction.guildId].language = language;
      saveDatabase(database);

      return interaction.reply(`Idioma actualizado: ${language}`);
    }

    if (name === "config") {
      const settings = readDatabase().servers[interaction.guildId] || {};

      return interaction.reply({
        content:
          `**Configuración de MINICAT IA**\n` +
          `Idioma: ${settings.language || "español colombiano"}`,
        ephemeral: true
      });
    }

    if (name === "userinfo") {
      const user = interaction.options.getUser("usuario") || interaction.user;

      return interaction.reply(
        `**Usuario:** ${user.tag}\n**ID:** ${user.id}\n**Creado:** <t:${Math.floor(user.createdTimestamp / 1000)}:D>`
      );
    }

    if (name === "serverinfo") {
      const guild = interaction.guild;

      return interaction.reply(
        `**${guild.name}**\nMiembros: ${guild.memberCount}\nID: ${guild.id}`
      );
    }

    if (name === "avatar") {
      const user = interaction.options.getUser("usuario") || interaction.user;

      return interaction.reply(
        user.displayAvatarURL({ size: 1024 })
      );
    }

    if (name === "poll") {
      const question = interaction.options.getString("pregunta");

      const poll = await interaction.reply({
        content: `📊 **${question}**\n\n👍 Sí\n👎 No`,
        fetchReply: true
      });

      await poll.react("👍");
      await poll.react("👎");
      return;
    }

    if (name === "suggest") {
      return interaction.reply({
        content: `💡 Sugerencia recibida:\n${interaction.options.getString("texto")}`,
        ephemeral: true
      });
    }

    if (name === "8ball") {
      const answers = [
        "Sí, definitivamente.",
        "Es posible.",
        "No lo creo.",
        "Pregunta más tarde.",
        "Todo apunta a que sí."
      ];

      return interaction.reply(
        answers[Math.floor(Math.random() * answers.length)]
      );
    }

    if (name === "coinflip") {
      return interaction.reply(
        Math.random() < 0.5 ? "🪙 Cara" : "🪙 Cruz"
      );
    }

    if (name === "dice") {
      return interaction.reply(
        `🎲 Resultado: ${Math.floor(Math.random() * 6) + 1}`
      );
    }

    if (name === "joke") {
      return interaction.reply(
        "¿Por qué el programador confundió Halloween con Navidad? Porque OCT 31 = DEC 25."
      );
    }

    if (name === "fact") {
      return interaction.reply(
        "🐱 Los gatos pueden hacer más de 100 sonidos vocales diferentes."
      );
    }

  } catch (error) {
    console.error("Error en comando:", error);

    const response = {
      content: "Ocurrió un error ejecutando el comando.",
      ephemeral: true
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(response).catch(() => {});
    } else {
      await interaction.reply(response).catch(() => {});
    }
  }
});

// =====================================
// COMANDOS CON PREFIJO Y MENCIÓN
// =====================================

client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();
  const mention = `<@${client.user?.id}>`;
  const mentionNick = `<@!${client.user?.id}>`;

  const mentioned =
    content.startsWith(mention) ||
    content.startsWith(mentionNick);

  const repliedToBot =
    message.reference?.messageId &&
    (await message.channel.messages.fetch(message.reference.messageId)
      .catch(() => null))?.author?.id === client.user.id;

  if (content.startsWith(PREFIX)) {
    const parts = content.slice(PREFIX.length).trim().split(/\s+/);
    const command = (parts.shift() || "").toLowerCase();
    const text = parts.join(" ");

    try {
      if (command === "help") {
        return replyLong(message, helpMessage());
      }

      if (command === "ping") {
        return message.reply(`🏓 Pong: ${client.ws.ping} ms`);
      }

      if (["chat", "hola"].includes(command)) {
        if (!text) {
          return message.reply("Escribe un mensaje para conversar conmigo.");
        }

        const answer = await runAI(
          message.author.id,
          message.guild.id,
          message.channel.id,
          text
        );

        return replyLong(message, answer);
      }

      if (command === "imagine") {
        if (!text) {
          return message.reply("Describe la imagen que quieres generar.");
        }

        await message.channel.sendTyping();

        const buffer = await generateImageBuffer(text);

        return message.reply({
          files: [
            new AttachmentBuilder(buffer, {
              name: "minicat-imagen.png"
            })
          ]
        });
      }

      if (command === "warn") {
        if (!isModerator(message.member)) {
          return message.reply("No tienes permisos.");
        }

        const user = message.mentions.users.first();
        if (!user) return message.reply("Menciona un usuario.");

        const reason = text.replace(/<@!?\d+>/, "").trim() || "Sin razón";

        const database = readDatabase();

        database.warnings[message.guild.id] ||= {};
        database.warnings[message.guild.id][user.id] ||= [];

        database.warnings[message.guild.id][user.id].push({
          moderatorId: message.author.id,
          reason,
          date: new Date().toISOString()
        });

        saveDatabase(database);

        return message.reply(`⚠️ Advertencia registrada para ${user.tag}.`);
      }

      if (command === "warnings") {
        if (!isModerator(message.member)) {
          return message.reply("No tienes permisos.");
        }

        const user = message.mentions.users.first();
        if (!user) return message.reply("Menciona un usuario.");

        const warnings =
          readDatabase().warnings[message.guild.id]?.[user.id] || [];

        return message.reply(
          warnings.length
            ? warnings.map((item, index) =>
                `${index + 1}. ${item.reason}`
              ).join("\n")
            : "Sin advertencias."
        );
      }

      if (command === "clear") {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
          return message.reply("No tienes permiso.");
        }

        const amount = Number(parts[0]);

        if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
          return message.reply("Usa .clear 1-100");
        }

        await message.channel.bulkDelete(amount, true);
        return message.channel.send(`Se eliminaron ${amount} mensajes.`);
      }

      if (command === "kick") {
        if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) {
          return message.reply("No tienes permiso.");
        }

        const target = message.mentions.members.first();

        if (!target?.kickable) {
          return message.reply("No puedo expulsar a ese usuario.");
        }

        await target.kick("Expulsado mediante MINICAT IA");
        return message.reply("Usuario expulsado.");
      }

      if (command === "ban") {
        if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) {
          return message.reply("No tienes permiso.");
        }

        const target = message.mentions.members.first();

        if (!target?.bannable) {
          return message.reply("No puedo banear a ese usuario.");
        }

        await target.ban({
          reason: "Baneado mediante MINICAT IA"
        });

        return message.reply("Usuario baneado.");
      }

      if (command === "timeout") {
        if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
          return message.reply("No tienes permiso.");
        }

        const target = message.mentions.members.first();
        const minutes = Number(parts[1]);

        if (!target?.moderatable || !Number.isInteger(minutes) ||
            minutes < 1 || minutes > 40320) {
          return message.reply("Uso: .timeout @usuario minutos");
        }

        await target.timeout(minutes * 60 * 1000);
        return message.reply(`Timeout aplicado: ${minutes} minutos.`);
      }

      if (command === "lock" || command === "unlock") {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
          return message.reply("No tienes permiso.");
        }

        await message.channel.permissionOverwrites.edit(
          message.guild.roles.everyone,
          { SendMessages: command === "unlock" }
        );

        return message.reply(
          command === "lock" ? "🔒 Canal bloqueado." : "🔓 Canal desbloqueado."
        );
      }

      if (command === "language") {
        if (!isAdministrator(message.member)) {
          return message.reply("Solo administradores pueden cambiar el idioma.");
        }

        const language = parts.join(" ");

        if (!["es", "español", "inglés", "en"].includes(language.toLowerCase())) {
          return message.reply("Idiomas disponibles: español, inglés.");
        }

        const database = readDatabase();
        database.servers[message.guild.id] ||= {};
        database.servers[message.guild.id].language =
          ["en", "inglés"].includes(language.toLowerCase())
            ? "inglés"
            : "español colombiano";

        saveDatabase(database);

        return message.reply("Idioma actualizado.");
      }

      if (command === "8ball") {
        const answers = [
          "Sí, definitivamente.",
          "Es posible.",
          "No lo creo.",
          "Pregunta más tarde."
        ];

        return message.reply(
          answers[Math.floor(Math.random() * answers.length)]
        );
      }

      if (command === "coinflip") {
        return message.reply(
          Math.random() < 0.5 ? "🪙 Cara" : "🪙 Cruz"
        );
      }

      if (command === "dice") {
        return message.reply(
          `🎲 ${Math.floor(Math.random() * 6) + 1}`
        );
      }

      if (command === "calculator") {
        return message.reply(
          "La calculadora avanzada todavía no está disponible."
        );
      }

      if (command === "choose") {
        const choices = text.split("|").map(item => item.trim()).filter(Boolean);

        if (choices.length < 2) {
          return message.reply("Uso: .choose opción 1 | opción 2");
        }

        return message.reply(
          `🎯 Elijo: **${choices[Math.floor(Math.random() * choices.length)]}**`
        );
      }

    } catch (error) {
      console.error("Error en prefijo:", error);
      return message.reply("Ocurrió un error ejecutando el comando.");
    }

    return;
  }

  if (mentioned || repliedToBot) {
    const question = content
      .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
      .trim();

    if (!question) {
      return message.reply("¡Hola! ¿En qué puedo ayudarte?");
    }

    try {
      await message.channel.sendTyping();

      const answer = await runAI(
        message.author.id,
        message.guild.id,
        message.channel.id,
        question
      );

      return replyLong(message, answer);

    } catch (error) {
      console.error("Error de IA en Discord:", error);
      return message.reply("No pude responder en este momento.");
    }
  }
});

// =====================================
// PRESENCIA
// =====================================

const activities = [
  { name: "MINICAT IA", type: ActivityType.Playing },
  { name: "tus preguntas", type: ActivityType.Listening },
  { name: "la comunidad", type: ActivityType.Watching }
];

let activityIndex = 0;

function updatePresence() {
  if (!client.user) return;

  const activity = activities[activityIndex];

  client.user.setPresence({
    activities: [activity],
    status: "online"
  });

  activityIndex = (activityIndex + 1) % activities.length;
}

client.once(Events.ClientReady, () => {
  console.log(`MINICAT IA CONECTADO: ${client.user.tag}`);

  updatePresence();
  setInterval(updatePresence, 5 * 60 * 1000);
});

// =====================================
// INICIO DEL SERVIDOR
// =====================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MINICAT IA WEB ACTIVA EN PUERTO ${PORT}`);

  if (!fs.existsSync(LOGO_PATH)) {
    console.warn("ATENCIÓN: No se encontró el logo oficial en public/.");
  }
});

async function startDiscord() {
  if (!process.env.DISCORD_TOKEN) {
    console.warn("DISCORD_TOKEN no configurado. Bot apagado.");
    return;
  }

  try {
    await registerCommands();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error("Error iniciando Discord:", error);
  }
}

startDiscord();
                          
