// index.js
import dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel } from '@discordjs/voice';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.content !== '!join') return;

  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) return;

  joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });
});

client.once('ready', () => {
  console.log(`Conectado como ${client.user.tag}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);
