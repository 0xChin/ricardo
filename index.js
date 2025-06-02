// index.js
import dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

client.once('ready', () => {
  console.log(`Conectado como ${client.user.tag}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);
