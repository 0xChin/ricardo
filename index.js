// index.js
import dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import Prism from 'prism-media';
import { createWriteStream } from 'fs';
import { unlink, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import OpenAI from 'openai';
import { createReadStream } from 'fs';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure ffmpeg
ffmpeg.setFfmpegPath(ffmpegStatic);

// Configure OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

let connection;
const userStreams = new Map();
const endTimers = new Map(); // Track end timers to debounce end events
const AUTHORIZED_USER_ID = '356096935062405120'; // User ID authorized to control recording
let isRecording = false;
let recordingSession = null;

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

// Function to transcribe audio using Whisper and add to session
async function transcribeAndAddToSession(wavFilePath, username, sessionData) {
  try {
    console.log(`[WHISPER] Starting transcription for ${username}...`);
    
    // Polyfill for Node 18 compatibility with OpenAI library
    if (!globalThis.File) {
      const { File } = await import('node:buffer');
      globalThis.File = File;
    }
    
    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(wavFilePath),
      model: 'gpt-4o-mini-transcribe',
      response_format: 'json'
    });

    const transcriptionEntry = {
      user: username,
      timestamp: new Date().toISOString(),
      text: transcription.text,
      audioFile: path.basename(wavFilePath)
    };

    // Add to session transcriptions
    sessionData.transcriptions.push(transcriptionEntry);
    
    console.log(`[WHISPER] Transcription completed for ${username}: "${transcription.text}"`);
    return transcriptionEntry;
  } catch (error) {
    console.error(`[WHISPER] Error transcribing audio for ${username}:`, error);
    throw error;
  }
}

// Function to save session data to JSON
async function saveSessionToJson(sessionData) {
  try {
    const sessionFilename = path.join(__dirname, `recording_session_${sessionData.sessionId}.json`);
    await writeFile(sessionFilename, JSON.stringify(sessionData, null, 2));
    console.log(`[SESSION] Session data saved to: ${path.basename(sessionFilename)}`);
    return sessionFilename;
  } catch (error) {
    console.error(`[SESSION] Error saving session data:`, error);
    throw error;
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log(`Connected as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  const textChannel = message.channel;
  
  // Handle !record command
  if (message.content === '!record') {
    if (message.author.id !== AUTHORIZED_USER_ID) {
      console.log(`[AUTH] Unauthorized user ${message.author.username} (${message.author.id}) attempted to start recording`);
      return;
    }
    
    if (isRecording) {
      console.log(`[RECORD] Recording already in progress, ignoring command from ${message.author.username}`);
      return;
    }
    
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      console.log(`[RECORD] User ${message.author.username} not in voice channel, cannot start recording`);
      return;
    }

    // Start recording session
    isRecording = true;
    const sessionId = Date.now();
    recordingSession = {
      sessionId: sessionId,
      startTime: new Date().toISOString(),
      endTime: null,
      channelName: voiceChannel.name,
      transcriptions: []
    };

    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      const receiver = connection.receiver;

      receiver.speaking.on('start', async (userId) => {
        if (!isRecording) return;
        
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
          const filename = path.join(__dirname, `session_${sessionId}_${userId}_${timestamp}.pcm`);
          const wavFilename = path.join(__dirname, `session_${sessionId}_${userId}_${timestamp}.wav`);
          const writeStream = createWriteStream(filename);

          // Use longer silence duration (30 seconds) to prevent premature ending
          const opusStream = receiver.subscribe(userId, { end: { behavior: 'silence', duration: 30000 } });
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
        } catch (error) {
          console.error(`[START] Error starting recording for user ${userId}:`, error);
          // Clean up any partial state in case of error
          if (userStreams.has(userId)) {
            userStreams.delete(userId);
          }
        }
      });

      receiver.speaking.on('end', async (userId) => {
        if (!isRecording) return;
        
        // Check if user was actually being recorded
        const info = userStreams.get(userId);
        if (!info) {
          console.log(`[END] Received end event for user ${userId} but no recording was active, ignoring`);
          return;
        }

        // Implement debounced ending - wait 6 seconds before actually ending
        // This prevents premature ending during brief pauses in speech
        console.log(`[END] End event received for user ${info.user} (${userId}), setting 6s delay before stopping`);
        
        // Clear any existing timer
        if (endTimers.has(userId)) {
          clearTimeout(endTimers.get(userId));
        }

        // Set a timer to actually end the recording after 6 seconds
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

            // Convert PCM to WAV
            try {
              await convertPcmToWav(currentInfo.pcmFilename, currentInfo.wavFilename);
              console.log(`[CONVERT] Audio converted: ${path.basename(currentInfo.wavFilename)}`);
              
              // Transcribe audio using Whisper and add to session
              try {
                const transcriptionEntry = await transcribeAndAddToSession(
                  currentInfo.wavFilename, 
                  user.username,
                  recordingSession
                );
                
                console.log(`[TRANSCRIPTION] ${user.username}: "${transcriptionEntry.text}"`);
                
                // Save updated session data
                await saveSessionToJson(recordingSession);
              } catch (transcriptionError) {
                console.error(`[WHISPER] Failed to transcribe audio for ${user.username}:`, transcriptionError);
              }
            } catch (convertError) {
              console.error(`[CONVERT] Failed to convert audio for ${user.username}:`, convertError);
            }
          } catch (error) {
            console.error(`[END] Error ending recording for user ${userId}:`, error);
            // Force cleanup even if there was an error
            userStreams.delete(userId);
            endTimers.delete(userId);
          }
        }, 6000); // 6 second delay

        endTimers.set(userId, endTimer);
      });
    });

    console.log(`[SESSION] Recording session ${sessionId} started in voice channel: ${voiceChannel.name}`);
  }
  
  // Handle !stop command
  else if (message.content === '!stop') {
    if (message.author.id !== AUTHORIZED_USER_ID) {
      console.log(`[AUTH] Unauthorized user ${message.author.username} (${message.author.id}) attempted to stop recording`);
      return;
    }
    
    if (!isRecording) {
      console.log(`[STOP] No recording in progress, ignoring command from ${message.author.username}`);
      return;
    }

    // Stop recording session
    isRecording = false;
    recordingSession.endTime = new Date().toISOString();
    
    // Clear all active recordings
    for (const [userId, info] of userStreams) {
      try {
        if (info.opusStream) {
          info.opusStream.destroy();
        }
        if (info.writeStream) {
          info.writeStream.end();
        }
      } catch (error) {
        console.error(`[STOP] Error cleaning up stream for user ${userId}:`, error);
      }
    }
    
    // Clear all timers
    for (const timer of endTimers.values()) {
      clearTimeout(timer);
    }
    
    userStreams.clear();
    endTimers.clear();
    
    // Disconnect from voice
    if (connection) {
      connection.destroy();
      connection = null;
    }
    
    // Save final session data
    try {
      const sessionFile = await saveSessionToJson(recordingSession);
      console.log(`[SESSION] Recording session ${recordingSession.sessionId} ended`);
      console.log(`[SESSION] Session file saved: ${path.basename(sessionFile)}`);
      console.log(`[SESSION] Total transcriptions: ${recordingSession.transcriptions.length}`);
    } catch (error) {
      console.error(`[SESSION] Error saving final session:`, error);
    }
    
    recordingSession = null;
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);