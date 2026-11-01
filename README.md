
# 🐱 MINICAT IA

Asistente inteligente para Discord y página web.

## 🚀 Requisitos

- Node.js 22 o superior.
- Servidor Veyro Host.
- Aplicación y bot de Discord.
- Clave de acceso de IA.
- Proveedor de generación de imágenes.

## 📁 Estructura

MINICAT-IA/
├── index.js
├── package.json
├── .env
├── config.json
├── README.md
├── public/
│   ├── index.html
│   ├── style.css
│   └── script.js
└── data/
    └── database.json

## ⚙️ Instalación

1. Sube los archivos al servidor de Veyro Host.
2. Comprueba que Node.js sea versión 22 o superior.
3. Instala las dependencias:

   npm install

4. Configura las variables del archivo .env.
5. Configura las credenciales de Discord.
6. Configura las claves de los proveedores.
7. Inicia el proyecto:

   npm start

## 🔐 Variables necesarias

- DISCORD_TOKEN
- DISCORD_CLIENT_ID
- DISCORD_CLIENT_SECRET
- DISCORD_REDIRECT_URI
- GROQ_API_KEY
- IMAGE_API_KEY
- IMAGE_API_URL
- SESSION_SECRET

## 🤖 Funciones previstas

- Asistente IA para Discord.
- Chat web con inicio de sesión Discord.
- Memoria independiente por conversación.
- Generación de imágenes.
- Análisis de imágenes y archivos.
- Creación de código y documentos.
- Moderación automática.
- Bienvenidas y despedidas.
- Estadísticas de servidores.
- Sistema de límites gratuitos.

## 📊 Límites gratuitos

- 100 mensajes cada 24 horas.
- 2 imágenes web cada 24 horas.
- 5 imágenes por servidor Discord cada 24 horas.

## 🔒 Privacidad

- Las conversaciones se almacenan por usuario.
- Cada conversación tiene su propio contexto.
- No se guardan contraseñas.
- Los registros técnicos no deben almacenar contenido de conversaciones.
- No publicar claves privadas ni tokens.

## 🌐 Hosting

Proyecto preparado para ejecutarse en Veyro Host mediante Node.js.

El puerto se obtiene de la variable PORT.

## 🐱 MINICAT IA

Versión: 1.0.0
Idioma inicial: Español
