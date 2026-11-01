
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs");
const Groq = require("groq-sdk");
const crypto = require("crypto");

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
const BASE_URL = process.env.BASE_URL || "";

const DATA_PATH = path.resolve(
  process.env.DATA_PATH || "./data/database.json"
);

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const PREFIX = ".";

// =====================================
// BASE DE DATOS LOCAL
// =====================================

const dataDirectory = path.dirname(DATA_PATH);

if (!fs.existsSync(dataDirectory)) {
  fs.mkdirSync(dataDirectory, { recursive: true });
}

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
  const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

  for (const key of [
    "users",
    "conversations",
    "servers",
    "limits",
    "statistics",
    "warnings"
  ]) {
    if (!data[key]) data[key] = {};
  }

  return data;
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
// SERVIDOR WEB
// =====================================

app.set("trust proxy", 1);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

if (!process.env.SESSION_SECRET) {
  console.error("Falta SESSION_SECRET en Railway.");
  process.exit(1);
}

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

    const database = readDatabase();

    database.users[user.id] = {
      id: user.id,
      username: user.username,
      globalName: user.global_name || user.username,
      avatar: user.avatar,
      lastLogin: new Date().toISOString()
    };

    saveDatabase(database);

    req.session.user = {
      id: user.id,
      username: user.username,
      globalName: user.global_name || user.username,
      avatar: user.avatar
    };

    req.session.save(error => {
      if (error) {
        console.error("Error guardando sesión:", error);
        return res.status(500).send("Error iniciando sesión.");
      }

      res.redirect("/chat");
    });

  } catch (error) {
    console.error("Error OAuth2:", error);
    res.status(500).send(
      "No se pudo iniciar sesión con Discord."
    );
  }
});

// =====================================
// AUTENTICACIÓN WEB
// =====================================

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/");
  }

  next();
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/me", requireLogin, (req, res) => {
  res.json({
    authenticated: true,
    user: req.session.user
  });
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("minicat.sid");
    res.redirect("/");
  });
});

app.get("/chat", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// =====================================
// INTELIGENCIA ARTIFICIAL
// =====================================

async function askMinicat(userId, conversationId, question, guildId = null) {
  if (!groq) {
    throw new Error("GROQ_API_KEY_NOT_CONFIGURED");
  }

  const database = readDatabase();

  if (!database.conversations[conversationId]) {
    database.conversations[conversationId] = {
      userId,
      messages: []
    };
  }

  const conversation = database.conversations[conversationId];

  const previousMessages = [...conversation.messages];

  conversation.messages.push({
    role: "user",
    content: question
  });

  conversation.messages = conversation.messages.slice(-12);

  const serverLanguage = guildId
    ? database.servers[guildId]?.language
    : null;

  const language = serverLanguage || "español colombiano";

  const messages = [
    {
      role: "system",
      content:
        `Eres MINICAT IA, un asistente inteligente y profesional. ` +
        `Responde en ${language}, de forma clara, natural y útil. ` +
        "Ayuda con programación, tecnología, explicaciones, preguntas " +
        "y tareas creativas. No reveles detalles internos de tus proveedores."
    },
    ...conversation.messages
  ];

  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages,
      max_completion_tokens: 1200
    });

    const answer =
      completion.choices?.[0]?.message?.content?.trim();

    if (!answer) {
      throw new Error("La IA devolvió una respuesta vacía.");
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
// GENERACIÓN DE IMÁGENES
// =====================================

async function generateImage(prompt) {
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
      options: {
        wait_for_model: true
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `IMAGE_API_ERROR_${response.status}: ${errorText.slice(0, 300)}`
    );
  }

  const contentType = response.headers.get("content-type") || "";

  if (!contentType.startsWith("image/")) {
    throw new Error("El proveedor no devolvió una imagen.");
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (!buffer.length) {
    throw new Error("La imagen generada está vacía.");
  }

  return new AttachmentBuilder(buffer, {
    name: "minicat-imagen.png"
  });
}

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

// =====================================
// UTILIDADES
// =====================================

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

function getArgs(content) {
  return content.trim().split(/\s+/).slice(1);
}

function getText(content) {
  return content.trim().split(/\s+/).slice(1).join(" ");
}

async function replyLong(message, content) {
  const chunks = content.match(/[\s\S]{1,1900}/g) || [];

  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) {
      await message.reply(chunks[i]);
    } else {
      await message.channel.send(chunks[i]);
    }
  }
}

async function interactionLong(interaction, content) {
  const chunks = content.match(/[\s\S]{1,1900}/g) || [];

  await interaction.editReply(chunks[0] || "Sin respuesta.");

  for (const chunk of chunks.slice(1)) {
    await interaction.followUp(chunk);
  }
}

function getGuildSettings(guildId) {
  const database = readDatabase();

  if (!database.servers[guildId]) {
    database.servers[guildId] = {};
    saveDatabase(database);
  }

  return database.servers[guildId];
}

function saveGuildSetting(guildId, key, value) {
  const database = readDatabase();

  if (!database.servers[guildId]) {
    database.servers[guildId] = {};
  }

  database.servers[guildId][key] = value;

  saveDatabase(database);
}

function getWarnings(guildId, userId) {
  const database = readDatabase();

  return database.warnings[guildId]?.[userId] || [];
}

function addWarning(guildId, userId, moderatorId, reason) {
  const database = readDatabase();

  if (!database.warnings[guildId]) {
    database.warnings[guildId] = {};
  }

  if (!database.warnings[guildId][userId]) {
    database.warnings[guildId][userId] = [];
  }

  database.warnings[guildId][userId].push({
    moderatorId,
    reason,
    date: new Date().toISOString()
  });

  saveDatabase(database);
}

// =====================================
// COMANDOS DE AYUDA
// =====================================

function helpMessage() {
  return [
    "🐱 **MINICAT IA — CENTRO DE COMANDOS**",
    "",
    "**🤖 Inteligencia artificial**",
    "`.chat mensaje` · `.hola Minicat` · `@MINICAT IA mensaje`",
    "`.resumir texto` · `.traducir texto`",
    "`.codigo lenguaje` · `.explicar tema` · `.analizar`",
    "",
    "**🖼️ Imágenes**",
    "`.imagine descripción`",
    "",
    "**🛡️ Moderación**",
    "`.warn` · `.warnings` · `.clear` · `.kick` · `.ban`",
    "`.unban` · `.timeout` · `.lock` · `.unlock`",
    "",
    "**⚙️ Administración**",
    "`.config` · `.welcome` · `.goodbye`",
    "`.stats` · `.language` · `.ping` · `.help`",
    "",
    "**🌐 Comunidad**",
    "`.userinfo` · `.serverinfo` · `.avatar`",
    "`.poll` · `.suggest`",
    "",
    "**🎮 Diversión**",
    "`.8ball` · `.coinflip` · `.dice`",
    "`.ship` · `.joke` · `.fact` · `.rps`",
    "",
    "**🧰 Herramientas**",
    "`.calculator` · `.choose` · `.userinfo`",
    "",
    "También puedes usar los comandos slash `/`."
  ].join("\n");
}

// =====================================
// FUNCIONES DE IA
// =====================================

async function runAI(userId, guildId, channelId, question) {
  const conversationId = getConversationId(
    guildId,
    channelId,
    userId
  );

  return askMinicat(
    userId,
    conversationId,
    question,
    guildId
  );
}

async function runImage(prompt) {
  return generateImage(prompt);
}

// =====================================
// COMANDOS SLASH
// =====================================

const slashCommands = [

  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Habla con MINICAT IA")
    .addStringOption(o =>
      o.setName("mensaje")
        .setDescription("Tu mensaje")
        .setRequired(true)
        .setMaxLength(1500)
    ),

  new SlashCommandBuilder()
    .setName("imagine")
    .setDescription("Genera una imagen")
    .addStringOption(o =>
      o.setName("descripcion")
        .setDescription("Describe la imagen")
        .setRequired(true)
        .setMaxLength(1000)
    ),

  new SlashCommandBuilder()
    .setName("resumir")
    .setDescription("Resume un texto")
    .addStringOption(o =>
      o.setName("texto").setDescription("Texto").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("traducir")
    .setDescription("Traduce un texto")
    .addStringOption(o =>
      o.setName("texto").setDescription("Texto").setRequired(true)
    )
    .addStringOption(o =>
      o.setName("idioma").setDescription("Idioma de destino").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("codigo")
    .setDescription("Crea código")
    .addStringOption(o =>
      o.setName("lenguaje").setDescription("Lenguaje").setRequired(true)
    )
    .addStringOption(o =>
      o.setName("descripcion").setDescription("Qué necesitas").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("explicar")
    .setDescription("Explica un tema")
    .addStringOption(o =>
      o.setName("tema").setDescription("Tema").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("analizar")
    .setDescription("Analiza una imagen adjunta")
    .addAttachmentOption(o =>
      o.setName("imagen").setDescription("Imagen que quieres analizar").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Comprueba la conexión"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Muestra los comandos"),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Advierte a un usuario")
    .addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true))
    .addStringOption(o => o.setName("razon").setDescription("Razón").setRequired(true)),

  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("Consulta advertencias")
    .addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true)),

  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Elimina mensajes recientes")
    .addIntegerOption(o => o.setName("cantidad").setDescription("Cantidad de mensajes").setRequired(true).setMinValue(1).setMaxValue(100)),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Expulsa a un usuario")
    .addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true))
    .addStringOption(o => o.setName("razon").setDescription("Razón").setRequired(false)),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Banea a un usuario")
    .addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true))
    .addStringOption(o => o.setName("razon").setDescription("Razón").setRequired(false)),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Desbanea por ID")
    .addStringOption(o => o.setName("id").setDescription("ID de Discord").setRequired(true)),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Aplica un tiempo de espera")
    .addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(true))
    .addIntegerOption(o => o.setName("minutos").setDescription("Duración en minutos").setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption(o => o.setName("razon").setDescription("Razón").setRequired(false)),

  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Bloquea el canal actual"),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Desbloquea el canal actual"),

  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Muestra la configuración del servidor"),

  new SlashCommandBuilder()
    .setName("welcome")
    .setDescription("Configura el canal de bienvenida")
    .addChannelOption(o => o.setName("canal").setDescription("Canal").setRequired(true)),

  new SlashCommandBuilder()
    .setName("goodbye")
    .setDescription("Configura el canal de despedidas")
    .addChannelOption(o => o.setName("canal").setDescription("Canal").setRequired(true)),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Estadísticas del servidor"),

  new SlashCommandBuilder()
    .setName("language")
    .setDescription("Cambia el idioma de MINICAT")
    .addStringOption(o =>
      o.setName("idioma").setDescription("Idioma").setRequired(true)
        .addChoices(
          { name: "Español", value: "español colombiano" },
          { name: "Inglés", value: "inglés" }
        )
    ),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Información de un usuario")
    .addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(false)),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Información del servidor"),

  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Muestra un avatar")
    .addUserOption(o => o.setName("usuario").setDescription("Usuario").setRequired(false)),

  new SlashCommandBuilder()
    .setName("poll")
    .setDescription("Crea una encuesta")
    .addStringOption(o => o.setName("pregunta").setDescription("Pregunta").setRequired(true)),

  new SlashCommandBuilder()
    .setName("suggest")
    .setDescription("Envía una sugerencia")
    .addStringOption(o => o.setName("texto").setDescription("Sugerencia").setRequired(true)),

  new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Pregunta a la bola mágica")
    .addStringOption(o => o.setName("pregunta").setDescription("Pregunta").setRequired(true)),

  new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("Lanza una moneda"),

  new SlashCommandBuilder()
    .setName("dice")
    .setDescription("Lanza un dado"),

  new SlashCommandBuilder()
    .setName("ship")
    .setDescription("Compatibilidad divertida")
    .addUserOption(o => o.setName("usuario1").setDescription("Primera persona").setRequired(true))
    .addUserOption(o => o.setName("usuario2").setDescription("Segunda persona").setRequired(true)),

  new SlashCommandBuilder()
    .setName("joke")
    
    .setDescription("Cuenta un chiste"),

  new SlashCommandBuilder()
    .setName("fact")
    .setDescription("Comparte un dato curioso"),

  new SlashCommandBuilder()
    .setName("rps")
    .setDescription("Piedra, papel o tijera")
    .addStringOption(o =>
      o.setName("eleccion")
        .setDescription("Tu elección")
        .setRequired(true)
        .addChoices(
          { name: "Piedra", value: "piedra" },
          { name: "Papel", value: "papel" },
          { name: "Tijera", value: "tijera" }
        )
    ),

  new SlashCommandBuilder()
    .setName("calculator")
    .setDescription("Calculadora básica")
    .addNumberOption(o =>
      o.setName("numero1")
        .setDescription("Primer número")
        .setRequired(true)
    )
    .addStringOption(o =>
      o.setName("operacion")
        .setDescription("Operación")
        .setRequired(true)
        .addChoices(
          { name: "Sumar", value: "+" },
          { name: "Restar", value: "-" },
          { name: "Multiplicar", value: "*" },
          { name: "Dividir", value: "/" }
        )
    )
    .addNumberOption(o =>
      o.setName("numero2")
        .setDescription("Segundo número")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("choose")
    .setDescription("Elige entre varias opciones")
    .addStringOption(o =>
      o.setName("opciones")
        .setDescription("Opciones separadas por comas")
        .setRequired(true)
    )

].map(command => command.toJSON());

// =====================================
// REGISTRO DE COMANDOS SLASH
// =====================================

async function registerSlashCommands() {
  const rest = new REST({ version: "10" })
    .setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: slashCommands }
  );

  console.log("Comandos slash registrados correctamente.");
}

// =====================================
// RESPUESTAS DIVERTIDAS
// =====================================

const eightBallAnswers = [
  "Sí, definitivamente.",
  "No lo creo.",
  "Puede ser.",
  "Las señales apuntan a que sí.",
  "Mejor pregunta más tarde.",
  "No cuentes con ello."
];

const jokes = [
  "¿Qué hace una abeja en el gimnasio? ¡Zum-ba!",
  "¿Qué le dijo un bit a otro? Nos vemos en el bus.",
  "¿Por qué el libro de matemáticas estaba triste? Tenía muchos problemas."
];

const facts = [
  "Los pulpos tienen tres corazones.",
  "La miel puede conservarse durante muchísimo tiempo.",
  "Los tiburones existen desde antes que los árboles.",
  "La luz del Sol tarda aproximadamente ocho minutos en llegar a la Tierra."
];

// =====================================
// CALCULADORA
// =====================================

function calculate(a, operator, b) {
  if (operator === "+") return a + b;
  if (operator === "-") return a - b;
  if (operator === "*") return a * b;

  if (operator === "/") {
    if (b === 0) {
      throw new Error("No se puede dividir entre cero.");
    }

    return a / b;
  }

  throw new Error("Operación no válida.");
}

// =====================================
// EJECUTOR DE COMANDOS
// =====================================

async function executeCommand(ctx, name, args = {}) {
  const isSlash = Boolean(ctx.isChatInputCommand?.());
  const guild = ctx.guild;
  const member = ctx.member;
  const user = ctx.user || ctx.author;
  const channel = ctx.channel;

  const reply = async content => {
    if (isSlash) {
      if (ctx.deferred || ctx.replied) {
        return ctx.editReply(content);
      }

      return ctx.reply(content);
    }

    return ctx.reply(content);
  };

  const defer = async () => {
    if (isSlash && !ctx.deferred && !ctx.replied) {
      await ctx.deferReply();
    }
  };

  const getUser = key =>
    isSlash ? ctx.options.getUser(key) : args[key];

  const getString = key =>
    isSlash ? ctx.options.getString(key) : args[key];

  const getNumber = key =>
    isSlash ? ctx.options.getNumber(key) : args[key];

  const moderatorOnly = async () => {
    if (!member || !member.permissions.has(
      PermissionFlagsBits.ModerateMembers
    ) && !member.permissions.has(
      PermissionFlagsBits.Administrator
    )) {
      await reply("No tienes permisos para utilizar este comando.");
      return false;
    }

    return true;
  };

  const adminOnly = async () => {
    if (!member || !member.permissions.has(
      PermissionFlagsBits.Administrator
    )) {
      await reply("Este comando requiere permisos de administrador.");
      return false;
    }

    return true;
  };

  // IA
  if (name === "chat") {
    const question = args.message || getString("mensaje");

    if (!question) return reply("Escribe un mensaje.");

    await defer();

    try {
      const answer = await runAI(
        user.id,
        guild.id,
        channel.id,
        question
      );

      return isSlash
        ? interactionLong(ctx, answer)
        : replyLong(ctx, answer);

    } catch (error) {
      console.error(error);
      return reply("No pude responder en este momento.");
    }
  }

  if (["resumir", "traducir", "codigo", "explicar"].includes(name)) {
    let prompt;

    if (name === "resumir") {
      prompt = `Resume este texto:\n${args.text || getString("texto")}`;
    }

    if (name === "traducir") {
      prompt = `Traduce al idioma ${args.language || getString("idioma")}:\n${args.text || getString("texto")}`;
    }

    if (name === "codigo") {
      prompt = `Crea código en ${args.language || getString("lenguaje")}: ${args.description || getString("descripcion")}`;
    }

    if (name === "explicar") {
      prompt = `Explica este tema de forma sencilla: ${args.text || getString("tema")}`;
    }

    await defer();

    try {
      const answer = await runAI(
        user.id,
        guild.id,
        channel.id,
        prompt
      );

      return isSlash
        ? interactionLong(ctx, answer)
        : replyLong(ctx, answer);

    } catch (error) {
      console.error(error);
      return reply("No pude procesar tu solicitud.");
    }
  }

  // IMÁGENES
  if (name === "imagine") {
    const prompt = args.prompt || getString("descripcion");

    if (!prompt) return reply("Describe la imagen que quieres generar.");

    await defer();

    try {
      const image = await runImage(prompt);

      if (isSlash) {
        return ctx.editReply({
          content: "🐱 ¡Tu imagen está lista!",
          files: [image]
        });
      }

      return ctx.reply({
        content: "🐱 ¡Tu imagen está lista!",
        files: [image]
      });

    } catch (error) {
      console.error("Error de imagen:", error);
      return reply("No pude generar la imagen. Inténtalo más tarde.");
    }
  }

  // MODERACIÓN
  if (name === "warn") {
    if (!await moderatorOnly()) return;

    const target = getUser("usuario");
    const reason = getString("razon") || "Sin razón especificada";

    if (!target) return reply("Selecciona un usuario.");

    addWarning(guild.id, target.id, user.id, reason);

    return reply(`⚠️ ${target} recibió una advertencia.\nRazón: ${reason}`);
  }

  if (name === "warnings") {
    if (!await moderatorOnly()) return;

    const target = getUser("usuario");
    if (!target) return reply("Selecciona un usuario.");

    const warnings = getWarnings(guild.id, target.id);

    if (!warnings.length) {
      return reply(`${target} no tiene advertencias.`);
    }

    return reply(
      warnings.map((w, i) =>
        `**${i + 1}.** ${w.reason} — <@${w.moderatorId}>`
      ).join("\n")
    );
  }

  if (name === "clear") {
    if (!await moderatorOnly()) return;

    const amount = ctx.options.getInteger("cantidad");

    try {
      const deleted = await channel.bulkDelete(amount, true);
      return reply(`Se eliminaron ${deleted.size} mensajes.`);
    } catch {
      return reply("No pude eliminar los mensajes. Revisa mis permisos.");
    }
  }

  if (["kick", "ban"].includes(name)) {
    if (!await moderatorOnly()) return;

    const target = getUser("usuario");
    const reason = getString("razon") || "Sin razón especificada";

    if (!target) return reply("Selecciona un usuario.");

    try {
      const targetMember = await guild.members.fetch(target.id);

      if (targetMember.permissions.has(PermissionFlagsBits.Administrator)) {
        return reply("No puedo sancionar a un administrador.");
      }

      if (name === "kick") {
        await targetMember.kick(reason);
        return reply(`${target.tag} fue expulsado.`);
      }

      await guild.members.ban(target.id, { reason });
      return reply(`${target.tag} fue baneado.`);

    } catch {
      return reply("No pude completar la acción. Revisa mis permisos y jerarquía.");
    }
  }

  if (name === "unban") {
    if (!await moderatorOnly()) return;

    const id = getString("id");

    if (!/^\d{17,20}$/.test(id || "")) {
      return reply("Escribe un ID válido.");
    }

    try {
      await guild.members.unban(id);
      return reply(`Se retiró el baneo de ${id}.`);
    } catch {
      return reply("No pude retirar ese baneo.");
    }
  }

  if (name === "timeout") {
    if (!await moderatorOnly()) return;

    const target = getUser("usuario");
    const minutes = ctx.options.getInteger("minutos");
    const reason = getString("razon") || "Sin razón especificada";

    if (!target) return reply("Selecciona un usuario.");

    try {
      const targetMember = await guild.members.fetch(target.id);

      if (targetMember.permissions.has(PermissionFlagsBits.Administrator)) {
        return reply("No puedo aplicar timeout a un administrador.");
      }

      await targetMember.timeout(minutes * 60000, reason);

      return reply(`${target} recibió timeout de ${minutes} minutos.`);
    } catch {
      return reply("No pude aplicar el timeout.");
    }
  }

  if (name === "lock" || name === "unlock") {
    if (!await moderatorOnly()) return;

    try {
      await channel.permissionOverwrites.edit(
        guild.roles.everyone,
        { SendMessages: name === "lock" ? false : null }
      );

      return reply(name === "lock"
        ? "🔒 Canal bloqueado."
        : "🔓 Canal desbloqueado."
      );
    } catch {
      return reply("No pude cambiar los permisos del canal.");
    }
  }

  // ADMINISTRACIÓN
  if (name === "config") {
    const settings = getGuildSettings(guild.id);

    return reply(
      `**⚙️ Configuración**\n` +
      `Bienvenida: ${settings.welcomeChannel ? `<#${settings.welcomeChannel}>` : "No configurada"}\n` +
      `Despedidas: ${settings.goodbyeChannel ? `<#${settings.goodbyeChannel}>` : "No configurada"}\n` +
      `Idioma: ${settings.language || "español colombiano"}`
    );
  }

  if (name === "welcome" || name === "goodbye") {
    if (!await adminOnly()) return;

    const target = ctx.options.getChannel("canal");

    saveGuildSetting(
      guild.id,
      name === "welcome" ? "welcomeChannel" : "goodbyeChannel",
      target.id
    );

    return reply(`Configuración guardada en ${target}.`);
  }

  if (name === "stats") {
    return reply(
      `**📊 Estadísticas**\nMiembros: ${guild.memberCount}\nCanales: ${guild.channels.cache.size}\nRoles: ${guild.roles.cache.size}`
    );
  }

  if (name === "language") {
    if (!await adminOnly()) return;

    const language = getString("idioma");

    saveGuildSetting(guild.id, "language", language);

    return reply(`Idioma actualizado: ${language}.`);
  }

  // COMUNIDAD
  if (name === "userinfo") {
    const target = getUser("usuario") || user;

    return reply(
      `**👤 Usuario**\nNombre: ${target.username}\nID: ${target.id}\nCuenta creada: <t:${Math.floor(target.createdTimestamp / 1000)}:D>`
    );
  }

  if (name === "serverinfo") {
    return reply(
      `**🌐 ${guild.name}**\nMiembros: ${guild.memberCount}\nCanales: ${guild.channels.cache.size}\nRoles: ${guild.roles.cache.size}`
    );
  }

  if (name === "avatar") {
    const target = getUser("usuario") || user;

    return reply(
      `**Avatar de ${target.username}**\n${target.displayAvatarURL({ size: 1024 })}`
    );
  }

  if (name === "poll") {
    const question = getString("pregunta");

    const poll = await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x7138ff)
          .setTitle("📊 Encuesta")
          .setDescription(question)
      ]
    });

    await poll.react("👍");
    await poll.react("👎");

    return reply(`Encuesta publicada: ${poll.url}`);
  }

  if (name === "suggest") {
    const text = getString("texto");

    const suggestion = await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x7138ff)
          .setTitle("💡 Sugerencia")
          .setDescription(text)
          .setFooter({ text: `Enviada por ${user.username}` })
      ]
    });

    await suggestion.react("👍");
    await suggestion.react("👎");

    return reply("Tu sugerencia fue publicada.");
  }

  // DIVERSIÓN
  if (name === "8ball") {
    return reply(
      `🎱 ${eightBallAnswers[Math.floor(Math.random() * eightBallAnswers.length)]}`
    );
  }

  if (name === "coinflip") {
    return reply(`🪙 ${Math.random() < 0.5 ? "Cara" : "Cruz"}`);
  }

  if (name === "dice") {
    return reply(`🎲 Resultado: ${Math.floor(Math.random() * 6) + 1}`);
  }

  if (name === "ship") {
    const first = getUser("usuario1");
    const second = getUser("usuario2");

    const percentage = Math.floor(Math.random() * 101);

    return reply(`💞 ${first} + ${second}: **${percentage}%**`);
  }

  if (name === "joke") {
    return reply(jokes[Math.floor(Math.random() * jokes.length)]);
  }

  if (name === "fact") {
    return reply(facts[Math.floor(Math.random() * facts.length)]);
  }

  if (name === "rps") {
    const choice = getString("eleccion");
    const choices = ["piedra", "papel", "tijera"];

    const botChoice = choices[Math.floor(Math.random() * 3)];

    let result = "Empate.";

    if (
      (choice === "piedra" && botChoice === "tijera") ||
      (choice === "papel" && botChoice === "piedra") ||
      (choice === "tijera" && botChoice === "papel")
    ) {
      result = "¡Ganaste!";
    } else if (choice !== botChoice) {
      result = "Ganó MINICAT.";
    }

    return reply(`Tú: ${choice}\nMINICAT: ${botChoice}\n${result}`);
  }

  // HERRAMIENTAS
  if (name === "calculator") {
    try {
      const result = calculate(
        getNumber("numero1"),
        getString("operacion"),
        getNumber("numero2")
      );

      return reply(`🧮 Resultado: **${result}**`);
    } catch (error) {
      return reply(error.message);
    }
  }

  if (name === "choose") {
    const options = getString("opciones")
      .split(",")
      .map(option => option.trim())
      .filter(Boolean);

    if (options.length < 2) {
      return reply("Escribe al menos dos opciones separadas por comas.");
    }

    return reply(
      `🎯 MINICAT elige: **${options[Math.floor(Math.random() * options.length)]}**`
    );
  }

  if (name === "ping") {
    return reply(`🐱 Pong: ${client.ws.ping} ms`);
  }

  if (name === "help") {
    return reply(helpMessage());
  }

  return reply("Comando no reconocido.");
}

// =====================================
// MENSAJES CON PREFIJO Y MENCIÓN
// =====================================

client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();

  if (!content) return;

  const mentionPattern = new RegExp(
    `^<@!?${client.user.id}>\\s*`
  );

  if (mentionPattern.test(content)) {
    const question = content.replace(mentionPattern, "").trim();

    if (!question) {
      return message.reply("¡Hola! 🐱 ¿Qué necesitas?");
    }

    await message.channel.sendTyping();

    try {
      const answer = await runAI(
        message.author.id,
        message.guild.id,
        message.channel.id,
        question
      );

      return replyLong(message, answer);
    } catch (error) {
      console.error(error);
      return message.reply("No pude responder en este momento.");
    }
  }

  if (!content.startsWith(PREFIX)) return;

  const parts = content.slice(1).trim().split(/\s+/);
  const name = (parts.shift() || "").toLowerCase();
  const rest = parts.join(" ");

  const aliases = {
    hola: "chat",
    imagine: "imagine",
    resumir: "resumir",
    traducir: "traducir",
    codigo: "codigo",
    explicar: "explicar"
  };

  const command = aliases[name] || name;

  if (command === "chat") {
    if (!rest) {
      return message.reply("Escribe tu mensaje.");
    }

    await message.channel.sendTyping();

    try {
      const answer = await runAI(
        message.author.id,
        message.guild.id,
        message.channel.id,
        rest
      );

      return replyLong(message, answer);
    } catch (error) {
      console.error(error);
      return message.reply("No pude responder en este momento.");
    }
  }

  if (command === "imagine") {
    return executeCommand(message, "imagine", {
      prompt: rest
    });
  }

  if (command === "resumir" ||
      command === "traducir" ||
      command === "explicar") {
    return executeCommand(message, command, {
      text: rest,
      language: "español"
    });
  }

  if (command === "codigo") {
    const firstSpace = rest.indexOf(" ");

    if (firstSpace === -1) {
      return message.reply("Uso: `.codigo javascript crea una calculadora`");
    }

    return executeCommand(message, "codigo", {
      language: rest.slice(0, firstSpace),
      description: rest.slice(firstSpace + 1)
    });
  }

  if (command === "help") return message.reply(helpMessage());

  if (command === "ping") {
    return message.reply(`🐱 Pong: ${client.ws.ping} ms`);
  }

  // El resto de comandos con prefijo se ampliará
  // con sus argumentos y validaciones correspondientes.
});

// =====================================
// INTERACCIONES SLASH
// =====================================

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await executeCommand(
      interaction,
      interaction.commandName
    );
  } catch (error) {
    console.error("Error de interacción:", error);

    const response = {
      content: "Ocurrió un error al ejecutar el comando.",
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
// BIENVENIDAS Y DESPEDIDAS
// =====================================

client.on(Events.GuildMemberAdd, async member => {
  try {
    const settings = getGuildSettings(member.guild.id);

    if (!settings.welcomeChannel) return;

    const channel = await member.guild.channels.fetch(
      settings.welcomeChannel
    ).catch(() => null);

    if (channel) {
      await channel.send(
        `🐱 ¡Bienvenido/a ${member}!`
      );
    }
  } catch (error) {
    console.error(error);
  }
});

client.on(Events.GuildMemberRemove, async member => {
  try {
    const settings = getGuildSettings(member.guild.id);

    if (!settings.goodbyeChannel) return;

    const channel = await member.guild.channels.fetch(
      settings.goodbyeChannel
    ).catch(() => null);

    if (channel) {
      await channel.send(
        `👋 ${member.user.username} ha salido del servidor.`
      );
    }
  } catch (error) {
    console.error(error);
  }
});

// =====================================
// ESTADÍSTICAS
// =====================================

client.on(Events.MessageCreate, message => {
  if (!message.guild || message.author.bot) return;

  try {
    const database = readDatabase();

    if (!database.statistics[message.guild.id]) {
      database.statistics[message.guild.id] = {
        messages: 0
      };
    }

    database.statistics[message.guild.id].messages++;

    saveDatabase(database);
  } catch (error) {
        console.error("Error actualizando estadísticas:", error);
  }
});

// =====================================
// EVENTO: BOT LISTO
// =====================================

client.once(Events.ClientReady, async () => {
  console.log(`MINICAT IA conectado como ${client.user.tag}`);

  await registerSlashCommands();

  client.user.setPresence({
    status: "online",
    activities: [
      {
        name: "MINICAT IA | Inteligencia Artificial",
        type: ActivityType.Watching
      }
    ]
  });

  setInterval(() => {
    const activities = [
      {
        name: "MINICAT IA | Inteligencia Artificial",
        type: ActivityType.Watching
      },
      {
        name: "Usa /help para ver mis comandos",
        type: ActivityType.Playing
      },
      {
        name: "Conversando contigo",
        type: ActivityType.Listening
      }
    ];

    const activity = activities[
      Math.floor(Math.random() * activities.length)
    ];

    client.user.setActivity(activity.name, {
      type: activity.type
    });
  }, 5 * 60 * 1000);
});

// =====================================
// API DE ESTADO
// =====================================

app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    name: "MINICAT IA",
    status: client.isReady() ? "online" : "starting",
    website: "online",
    timestamp: new Date().toISOString()
  });
});

// =====================================
// ARCHIVOS DE LA PÁGINA WEB
// =====================================

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/chat", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// =====================================
// RUTA NO ENCONTRADA
// =====================================

app.use((req, res) => {
  res.status(404).send("Página no encontrada.");
});

// =====================================
// INICIAR SERVIDOR
// =====================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MINICAT IA web iniciado en el puerto ${PORT}`);
});

// =====================================
// CONECTAR BOT A DISCORD
// =====================================

client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error("Error conectando MINICAT IA a Discord:", error);
});
