
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs");
const {
  Client,
  GatewayIntentBits,
  ActivityType
} = require("discord.js");

const app = express();

const PORT = process.env.PORT || 3000;
const DATA_PATH = path.resolve(
  process.env.DATA_PATH || "./data/database.json"
);

app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch (error) {
    console.error("Error leyendo la base de datos:", error);
    throw error;
  }
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
// SESIONES
// ==============================

if (!process.env.SESSION_SECRET) {
  console.error("Falta SESSION_SECRET en el archivo .env");
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
      "El inicio de sesión de Discord no está configurado."
    );
  }

  const state = require("crypto")
    .randomBytes(24)
    .toString("hex");

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
      throw new Error("No se pudo obtener el usuario de Discord.");
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

    req.session.save((error) => {
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

// ==============================
// CHAT
// ==============================

app.get("/chat", requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ==============================
// ARCHIVOS WEB
// ==============================

app.use(express.static(
  path.join(__dirname, "public")
));

// ==============================
// BOT DE DISCORD
// ==============================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", () => {
  console.log(`MINICAT IA conectado como ${client.user.tag}`);

  const activities = [
    "Ayudando a la comunidad",
    "Respondiendo preguntas",
    "MINICAT IA"
  ];

  let index = 0;

  client.user.setStatus("dnd");

  client.user.setActivity(activities[index], {
    type: ActivityType.Playing
  });

  setInterval(() => {
    index = (index + 1) % activities.length;

    client.user.setActivity(activities[index], {
      type: ActivityType.Playing
    });
  }, 300000);
});

client.on("error", (error) => {
  console.error("Error del bot:", error);
});

if (process.env.DISCORD_TOKEN) {
  client.login(process.env.DISCORD_TOKEN)
    .catch(error => {
      console.error("No se pudo conectar el bot:", error);
    });
} else {
  console.warn("DISCORD_TOKEN no configurado. Bot desconectado.");
}

// ==============================
// RUTAS DE ESTADO
// ==============================

app.get("/api/status", (req, res) => {
  res.json({
    name: "MINICAT IA",
    status: "online",
    discord: client.isReady() ? "connected" : "disconnected"
  });
});

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
