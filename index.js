
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs");
const Groq = require("groq-sdk");

const {
  Client,
  GatewayIntentBits,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder,
  Events
} = require("discord.js");

const app = express();

const PORT = process.env.PORT || 3000;
const DATA_PATH = path.resolve(
  process.env.DATA_PATH || "./data/database.json"
);

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

// ==============================
// ALMACENAMIENTO
// ==============================

const dataDirectory = path.dirname(DATA_PATH);

if (!fs.existsSync(dataDirectory)) {
  fs.mkdirSync(dataDirectory, { recursive: true });
}

if (!fs.existsSync(DATA_PATH)) {
  fs.writeFileSync(
    DATA_PATH,
    JSON.stringify({
      users: {},
      conversations: {},
      servers: {},
      limits: {},
      statistics: {},
      settings: {
        language: "es",
        timezone: "America/Bogota",
        freeMessages: 100,
        webImages: 2,
        discordImages: 5,
        resetHours: 24
      }
    }, null, 2)
  );
}

function readDatabase() {
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
}

function saveDatabase(database) {
  const temporaryPath = DATA_PATH + ".tmp";

  fs.writeFileSync(
    temporaryPath,
    JSON.stringify(database, null, 2)
  );

  fs.renameSync(temporaryPath, DATA_PATH);
}

// ==============================
// CONFIGURACIÓN WEB
// ==============================

app.set("trust proxy", 1);
app.use(express.json());
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

// ==============================
// DISCORD OAUTH2
// ==============================

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

  const crypto = require("crypto");

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

// ==============================
// AUTENTICACIÓN
// ==============================

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/");
  }

  next();
}

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

// ==============================
// INTELIGENCIA ARTIFICIAL
// ==============================

async function askMinicat(userId, conversationId, question) {
  if (!groq) {
    throw new Error("GROQ_API_KEY_NOT_CONFIGURED");
  }

  const database = readDatabase();

  if (!database.conversations) {
    database.conversations = {};
  }

  if (!database.conversations[conversationId]) {
    database.conversations[conversationId] = {
      userId,
      messages: []
    };
  }

  const conversation = database.conversations[conversationId];

  conversation.messages.push({
    role: "user",
    content: question
  });

  // Mantener los últimos mensajes de esta conversación.
  conversation.messages = conversation.messages.slice(-12);

  const messages = [
    {
      role: "system",
      content:
        "Eres MINICAT IA, un asistente inteligente, útil y profesional. " +
        "Responde en español colombiano de forma clara y natural. " +
        "Ayuda con preguntas, programación, tecnología, explicaciones " +
        "y tareas creativas. No reveles detalles internos de tus proveedores."
    },
    ...conversation.messages
  ];

  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages,
      max_completion_tokens: 1000
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
    // Eliminar el mensaje que quedó sin respuesta.
    conversation.messages.pop();
    saveDatabase(database);
    throw error;
  }
}

// ==============================
// COMANDOS DE DISCORD
// ==============================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

async function sendLongMessage(target, content) {
  const chunks = content.match(/[\s\S]{1,1900}/g) || [];

  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) {
      await target.reply(chunks[i]);
    } else {
      await target.channel.send(chunks[i]);
    }
  }
}

// ==============================
// COMANDOS SLASH
// ==============================

const slashCommands = [
  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Habla con MINICAT IA")
    .addStringOption(option =>
      option
        .setName("mensaje")
        .setDescription("Escribe tu pregunta")
        .setRequired(true)
        .setMaxLength(1500)
    ),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Comprueba si MINICAT está conectado"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Muestra los comandos de MINICAT IA")
].map(command => command.toJSON());

async function registerSlashCommands() {
  try {
    const rest = new REST({ version: "10" })
      .setToken(process.env.DISCORD_TOKEN);

    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: slashCommands }
    );

    console.log("Comandos slash registrados correctamente.");

  } catch (error) {
    console.error("Error registrando comandos slash:", error);
  }
}

// ==============================
// EVENTO DE INICIO
// ==============================

client.once(Events.ClientReady, async readyClient => {
  console.log(
    `MINICAT IA conectado como ${readyClient.user.tag}`
  );

  await registerSlashCommands();

  const activities = [
    "Ayudando a la comunidad",
    "Respondiendo preguntas",
    "MINICAT IA"
  ];

  let index = 0;

  readyClient.user.setStatus("dnd");

  readyClient.user.setActivity(activities[index], {
    type: ActivityType.Playing
  });

  setInterval(() => {
    index = (index + 1) % activities.length;

    readyClient.user.setActivity(activities[index], {
      type: ActivityType.Playing
    });
  }, 300000);
});

// ==============================
// MENSAJES CON PREFIJO
// ==============================

client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();

  if (content.startsWith(".ping")) {
    return message.reply("¡Pong! 🐱 MINICAT IA está conectado.");
  }

  if (content === ".help") {
    return message.reply(
      "**🐱 MINICAT IA — Comandos**\n\n" +
      "`.chat pregunta` — Conversar con MINICAT.\n" +
      "`.ping` — Comprobar conexión.\n" +
      "`.help` — Ver comandos.\n\n" +
      "**También puedes usar los comandos `/`.**"
    );
  }

  if (!content.startsWith(".chat ")) return;

  const question = content.slice(6).trim();

  if (!question) {
    return message.reply("Escribe una pregunta después de `.chat`.");
  }

  await message.channel.sendTyping();

  try {
    const conversationId =
      `discord:${message.guild.id}:${message.channel.id}:${message.author.id}`;

    const answer = await askMinicat(
      message.author.id,
      conversationId,
      question
    );

    await sendLongMessage(message, answer);

  } catch (error) {
    console.error("Error en .chat:", error);

    await message.reply(
      "No pude responder en este momento. Inténtalo nuevamente."
    );
  }
});

// ==============================
// INTERACCIONES SLASH
// ==============================

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    return interaction.reply(
      "¡Pong! 🐱 MINICAT IA está conectado."
    );
  }

  if (interaction.commandName === "help") {
    return interaction.reply(
      "**🐱 MINICAT IA — Comandos**\n\n" +
      "`/chat` — Conversar con MINICAT.\n" +
      "`/ping` — Comprobar conexión.\n" +
      "`/help` — Ver comandos.\n\n" +
      "También puedes utilizar el prefijo `.`."
    );
  }

  if (interaction.commandName === "chat") {
    const question = interaction.options.getString("mensaje");

    await interaction.deferReply();

    try {
      const conversationId =
        `discord:${interaction.guildId}:${interaction.channelId}:${interaction.user.id}`;

      const answer = await askMinicat(
        interaction.user.id,
        conversationId,
        question
      );

      const chunks = answer.match(/[\s\S]{1,1900}/g) || [];

      await interaction.editReply(chunks[0] || "No recibí respuesta.");

      for (const chunk of chunks.slice(1)) {
        await interaction.followUp(chunk);
      }

    } catch (error) {
      console.error("Error en /chat:", error);

      await interaction.editReply(
        "No pude responder en este momento. Inténtalo nuevamente."
      );
    }
  }
});

// ==============================
// ERRORES DEL BOT
// ==============================

client.on("error", error => {
  console.error("Error del bot:", error);
});

process.on("unhandledRejection", error => {
  console.error("Error no controlado:", error);
});

// ==============================
// ESTADO
// ==============================

app.get("/api/status", (req, res) => {
  res.json({
    name: "MINICAT IA",
    status: "online",
    discord: client.isReady() ? "connected" : "disconnected",
    ai: groq ? "configured" : "not_configured"
  });
});

// ==============================
// ARCHIVOS WEB Y 404
// ==============================

app.use(express.static(
  path.join(__dirname, "public")
));

app.use((req, res) => {
  res.status(404).send("Página no encontrada.");
});

// ==============================
// INICIAR SERVIDOR
// ==============================

app.listen(PORT, "0.0.0.0", () => {
  console.log("--------------------------------");
  console.log("MINICAT IA iniciado correctamente");
  console.log(`Puerto: ${PORT}`);
  console.log("--------------------------------");
});

if (process.env.DISCORD_TOKEN) {
  client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error("No se pudo conectar el bot:", error);
  });
} else {
  console.warn("DISCORD_TOKEN no configurado.");
  }
  
