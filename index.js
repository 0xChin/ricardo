// index.js
import dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import Prism from 'prism-media';
import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import wav from 'wav';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure ffmpeg
ffmpeg.setFfmpegPath(ffmpegStatic);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let connection;
const userStreams = new Map();
const endTimers = new Map(); // Track end timers to debounce end events

// Function to convert PCM to WAV
async function convertPcmToWav(pcmFilePath, wavFilePath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(pcmFilePath)
      .inputFormat('s16le') // 16-bit signed little-endian PCM
      .inputOptions([
        '-ar 48000', // Sample rate 48kHz
        '-ac 2'      // 2 channels (stereo)
      ])
      .output(wavFilePath)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', () => {
        console.log(`[CONVERT] Successfully converted ${pcmFilePath} to ${wavFilePath}`);
        // Delete the PCM file after conversion
        unlink(pcmFilePath).catch(err => console.error(`Error deleting PCM file: ${err}`));
        resolve();
      })
      .on('error', (err) => {
        console.error(`[CONVERT] Error converting ${pcmFilePath}:`, err);
        reject(err);
      })
      .run();
  });
}

client.once('ready', () => {
  console.log(`Conectado como ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || message.content !== '!join') return;
  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) return;

  const textChannel = message.channel;
  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  connection.on(VoiceConnectionStatus.Ready, () => {
    const receiver = connection.receiver;

    receiver.speaking.on('start', async (userId) => {
      // Check if user is already being recorded
      if (userStreams.has(userId)) {
        console.log(`[START] User ${userId} is already being recorded, ignoring duplicate start event`);
        return;
      }

      // Cancel any pending end timer for this user
      if (endTimers.has(userId)) {
        clearTimeout(endTimers.get(userId));
        endTimers.delete(userId);
        console.log(`[START] Cancelled pending end timer for user ${userId}`);
      }

      try {
        const user = await client.users.fetch(userId);
        const timestamp = Date.now();
        const filename = path.join(__dirname, `audio_${userId}_${timestamp}.pcm`);
        const wavFilename = path.join(__dirname, `audio_${userId}_${timestamp}.wav`);
        const writeStream = createWriteStream(filename);

        // Use longer silence duration (10 seconds) to prevent premature ending
        const opusStream = receiver.subscribe(userId, { end: { behavior: 'silence', duration: 10000 } });
        const decoder = new Prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
        const pcmStream = opusStream.pipe(decoder);
        pcmStream.pipe(writeStream);

        // Set the user stream info immediately to mark as recording
        userStreams.set(userId, { 
          writeStream, 
          opusStream,
          user: user.username,
          startTime: timestamp,
          pcmFilename: filename,
          wavFilename: wavFilename
        });
        
        console.log(`[START] Recording started for user ${user.username} (${userId})`);
        textChannel.send(`▶️ Comenzó a hablar: **${user.username}**`);
      } catch (error) {
        console.error(`[START] Error starting recording for user ${userId}:`, error);
        // Clean up any partial state in case of error
        if (userStreams.has(userId)) {
          userStreams.delete(userId);
        }
      }
    });

    receiver.speaking.on('end', async (userId) => {
      // Check if user was actually being recorded
      const info = userStreams.get(userId);
      if (!info) {
        console.log(`[END] Received end event for user ${userId} but no recording was active, ignoring`);
        return;
      }

      // Implement debounced ending - wait 2 seconds before actually ending
      // This prevents premature ending during brief pauses in speech
      console.log(`[END] End event received for user ${info.user} (${userId}), setting 2s delay before stopping`);
      
      // Clear any existing timer
      if (endTimers.has(userId)) {
        clearTimeout(endTimers.get(userId));
      }

      // Set a timer to actually end the recording after 2 seconds
      const endTimer = setTimeout(async () => {
        // Double-check the user is still in userStreams (might have restarted)
        const currentInfo = userStreams.get(userId);
        if (!currentInfo) {
          console.log(`[END] User ${userId} no longer being recorded, timer cancelled`);
          endTimers.delete(userId);
          return;
        }

        try {
          // Clean up streams
          if (currentInfo.opusStream) {
            currentInfo.opusStream.destroy();
          }
          if (currentInfo.writeStream) {
            currentInfo.writeStream.end();
          }
          
          // Remove from active recordings
          userStreams.delete(userId);
          endTimers.delete(userId);

          const user = await client.users.fetch(userId);
          const duration = Date.now() - currentInfo.startTime;
          
          console.log(`[END] Recording ended for user ${user.username} (${userId}) - Duration: ${duration}ms`);
          textChannel.send(`⏹️ Dejó de hablar: **${user.username}**`);

          // Convert PCM to WAV
          try {
            await convertPcmToWav(currentInfo.pcmFilename, currentInfo.wavFilename);
            textChannel.send(`🎵 Audio guardado: **${path.basename(currentInfo.wavFilename)}**`);
          } catch (convertError) {
            console.error(`[CONVERT] Failed to convert audio for ${user.username}:`, convertError);
            textChannel.send(`❌ Error al convertir audio de **${user.username}**`);
          }
        } catch (error) {
          console.error(`[END] Error ending recording for user ${userId}:`, error);
          // Force cleanup even if there was an error
          userStreams.delete(userId);
          endTimers.delete(userId);
        }
      }, 2000); // 2 second delay

      endTimers.set(userId, endTimer);
    });
  });
});

client.login(process.env.DISCORD_BOT_TOKEN);
