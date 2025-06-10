// index.js
import dotenv from 'dotenv';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { Client as NotionClient } from '@notionhq/client';
import { markdownToBlocks } from '@tryfabric/martian';
import { joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import Prism from 'prism-media';
import { createWriteStream } from 'fs';
import { unlink, writeFile, mkdir, readFile } from 'fs/promises';
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

// Configure Notion
const notion = new NotionClient({
  auth: process.env.NOTION_KEY,
});

// Function to sync summary to Notion page
async function syncToNotion(summary, pageId) {
  try {
    console.log(`[NOTION] Syncing summary to Notion page: ${pageId}`);
    
    // Convert markdown to Notion blocks
    const blocks = markdownToBlocks(summary);
    
    // Limit to 100 blocks (Notion API limitation)
    if (blocks.length > 100) {
      console.log(`[NOTION] Warning: Summary has ${blocks.length} blocks, truncating to 100`);
      blocks.splice(100);
    }
    
    // Add divider and timestamp before the summary
    const dividerBlocks = [
      {
        object: 'block',
        type: 'divider',
        divider: {}
      },
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: `Meeting Summary - ${new Date().toLocaleString()}`
              },
              annotations: {
                bold: true,
                color: 'gray'
              }
            }
          ]
        }
      }
    ];
    
    // Append divider, timestamp, and summary to existing content
    await notion.blocks.children.append({
      block_id: pageId,
      children: [...dividerBlocks, ...blocks],
    });
    
    console.log(`[NOTION] Successfully appended summary to Notion page`);
    return true;
  } catch (error) {
    console.error(`[NOTION] Error syncing to Notion:`, error);
    return false;
  }
}

// Function to add a divider to separate summaries (no longer clearing page)
async function addNotionDivider(pageId) {
  try {
    const dividerBlock = {
      object: 'block',
      type: 'divider',
      divider: {}
    };
    
    await notion.blocks.children.append({
      block_id: pageId,
      children: [dividerBlock],
    });
    
    console.log(`[NOTION] Added divider to page`);
  } catch (error) {
    console.error(`[NOTION] Error adding divider:`, error);
    throw error;
  }
}

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

// Function to generate summary using OpenAI
async function generateSummary(sessionData, templateName = 'default') {
  try {
    const templatePath = path.join(__dirname, 'templates', `${templateName}.md`);
    let template = await readFile(templatePath, 'utf8');
    
    // Load template configurations
    const templateConfigs = await loadTemplateConfigs();
    const templateConfig = templateConfigs[templateName] || templateConfigs.default;
    
    // Prepare transcript text
    const transcriptText = sessionData.transcriptions
      .map(t => `${t.user}: ${t.text}`)
      .join('\n');
    
    if (!transcriptText.trim()) {
      console.log('[SUMMARY] No transcriptions to summarize');
      return null;
    }
    
    // Use template-specific prompt with transcript injection
    const prompt = templateConfig.prompt.replace('{transcript}', transcriptText);
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2
    });
    
    const aiResponse = completion.choices[0].message.content;
    const sections = aiResponse.split('---SECTION---').map(s => s.trim());
    
    // Calculate duration
    const startTime = new Date(sessionData.startTime);
    const endTime = new Date(sessionData.endTime);
    const durationMs = endTime - startTime;
    const durationMin = Math.round(durationMs / 60000);
    
    // Get participants
    const participants = [...new Set(sessionData.transcriptions.map(t => t.user))].join(', ');
    
    // Fill template placeholders
    template = template.replace('[date]', startTime.toLocaleDateString());
    template = template.replace('[channel]', sessionData.channelName);
    template = template.replace('[duration]', `${durationMin} minutes`);
    template = template.replace('[participants]', participants || 'None');
    
    // Fill content sections with parsed AI response
    // For default template: sections[0] = title, sections[1] = key_points, sections[2] = summary, sections[3] = action_items
    // For other templates: keep existing 3-section format
    if (templateName === 'default' && sections.length >= 4) {
      template = template.replace('[title]', sections[0] || 'Meeting Summary');
      template = template.replace('[key_points]', sections[1] || 'None');
      template = template.replace('[discussion_summary]', sections[2] || 'No discussion summary available');
      template = template.replace('[action_items]', sections[3] || 'None');
    } else {
      // Fallback for other templates or if parsing fails
      template = template.replace('[title]', 'Meeting Summary'); // fallback title
      template = template.replace('[key_points]', sections[0] || 'None');
      template = template.replace('[discussion_summary]', sections[1] || 'No discussion summary available');
      template = template.replace('[action_items]', sections[2] || 'None');
    }
    
    return template;
  } catch (error) {
    console.error('[SUMMARY] Error generating summary:', error);
    return null;
  }
}

// Function to save session data to JSON
async function saveSessionToJson(sessionData) {
  try {
    const sessionFolder = path.join(__dirname, 'sessions', `session_${sessionData.sessionId}`);
    await mkdir(sessionFolder, { recursive: true });
    const sessionFilename = path.join(sessionFolder, `recording_session_${sessionData.sessionId}.json`);
    await writeFile(sessionFilename, JSON.stringify(sessionData, null, 2));
    console.log(`[SESSION] Session data saved to: ${path.relative(__dirname, sessionFilename)}`);
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

// Load template configurations
async function loadTemplateConfigs() {
  try {
    const configPath = path.join(__dirname, 'templates', 'templates.json');
    const configData = await readFile(configPath, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    console.error('[TEMPLATES] Error loading template configs:', error);
    return { default: { name: 'Default', description: 'Default template' } };
  }
}

// Define slash commands
async function createCommands() {
  const templateConfigs = await loadTemplateConfigs();
  const templateChoices = Object.entries(templateConfigs).map(([key, config]) => ({
    name: config.name,
    value: key
  }));

  return [
    new SlashCommandBuilder()
      .setName('record')
      .setDescription('Start recording voice channel'),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Stop recording and generate summary')
      .addStringOption(option =>
        option.setName('template')
          .setDescription('Choose a template for the summary')
          .addChoices(...templateChoices)
          .setRequired(false)
      )
      .addStringOption(option =>
        option.setName('notion_page_id')
          .setDescription('Notion page ID to sync the summary to (optional)')
          .setRequired(false)
      )
  ].map(command => command.toJSON());
}

// Register slash commands
async function registerCommands() {
  try {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    console.log('[SLASH] Started refreshing application (/) commands.');
    
    const commands = await createCommands();
    
    // Register commands globally (you can also register per guild for faster updates during development)
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands },
    );
    
    console.log('[SLASH] Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('[SLASH] Error registering commands:', error);
  }
}

client.once('ready', async () => {
  console.log(`Connected as ${client.user.tag}`);
  await registerCommands();
});

// Handle slash command interactions
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  
  // Handle /record command
  if (interaction.commandName === 'record') {
    if (interaction.user.id !== AUTHORIZED_USER_ID) {
      console.log(`[AUTH] Unauthorized user ${interaction.user.username} (${interaction.user.id}) attempted to start recording`);
      await interaction.reply({ content: 'You are not authorized to use this command.', ephemeral: true });
      return;
    }
    
    if (isRecording) {
      console.log(`[RECORD] Recording already in progress, ignoring command from ${interaction.user.username}`);
      await interaction.reply({ content: 'Recording is already in progress.', ephemeral: true });
      return;
    }
    
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      console.log(`[RECORD] User ${interaction.user.username} not in voice channel, cannot start recording`);
      await interaction.reply({ content: 'You must be in a voice channel to start recording.', ephemeral: true });
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
        
        // Cancel any pending end timer for this user (if they started speaking again)
        if (endTimers.has(userId)) {
          clearTimeout(endTimers.get(userId));
          endTimers.delete(userId);
          console.log(`[START] Cancelled pending end timer for user ${userId} - user started speaking again`);
        }

        // Check if user is already being recorded
        if (userStreams.has(userId)) {
          console.log(`[START] User ${userId} is already being recorded, continuing existing stream`);
          return;
        }

        try {
          const user = await client.users.fetch(userId);
          const timestamp = Date.now();
          const sessionFolder = path.join(__dirname, 'sessions', `session_${sessionId}`);
          await mkdir(sessionFolder, { recursive: true });
          const filename = path.join(sessionFolder, `session_${sessionId}_${userId}_${timestamp}.pcm`);
          const wavFilename = path.join(sessionFolder, `session_${sessionId}_${userId}_${timestamp}.wav`);
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

        // Implement debounced ending - wait 1 second before actually ending
        // This prevents premature ending during brief pauses and accounts for user lag
        console.log(`[END] End event received for user ${info.user} (${userId}), setting 1s delay before stopping`);
        
        // Clear any existing timer
        if (endTimers.has(userId)) {
          clearTimeout(endTimers.get(userId));
        }

        // Set a timer to actually end the recording after 3 seconds
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

            // Convert PCM to WAV and transcribe asynchronously (non-blocking)
            // This allows the bot to continue listening while processing previous audio
            setImmediate(async () => {
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
            });
          } catch (error) {
            console.error(`[END] Error ending recording for user ${userId}:`, error);
            // Force cleanup even if there was an error
            userStreams.delete(userId);
            endTimers.delete(userId);
          }
        }, 1000); // 1 second delay

        endTimers.set(userId, endTimer);
      });
    });

    console.log(`[SESSION] Recording session ${sessionId} started in voice channel: ${voiceChannel.name}`);
    await interaction.reply({ content: `Recording started in ${voiceChannel.name}`, ephemeral: true });
  }
  
  // Handle /stop command
  else if (interaction.commandName === 'stop') {
    if (interaction.user.id !== AUTHORIZED_USER_ID) {
      console.log(`[AUTH] Unauthorized user ${interaction.user.username} (${interaction.user.id}) attempted to stop recording`);
      await interaction.reply({ content: 'You are not authorized to use this command.', ephemeral: true });
      return;
    }
    
    if (!isRecording) {
      console.log(`[STOP] No recording in progress, ignoring command from ${interaction.user.username}`);
      await interaction.reply({ content: 'No recording is currently in progress.', ephemeral: true });
      return;
    }
    
    // Get template choice and notion page ID from user
    const templateChoice = interaction.options.getString('template') || 'default';
    const notionPageId = interaction.options.getString('notion_page_id');
    recordingSession.templateChoice = templateChoice;
    recordingSession.notionPageId = notionPageId;
    
    const notionText = notionPageId ? ' and syncing to Notion' : '';
    await interaction.reply({ content: `Stopping recording and generating summary using ${templateChoice} template${notionText}...`, ephemeral: true });

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
      
      // Generate and save summary
      if (recordingSession.transcriptions.length > 0) {
        try {
          // Get template choice from interaction (will be null for old sessions)
          const templateChoice = recordingSession.templateChoice || 'default';
          const summary = await generateSummary(recordingSession, templateChoice);
          if (summary) {
            const sessionFolder = path.join(__dirname, 'sessions', `session_${recordingSession.sessionId}`);
            const summaryFile = path.join(sessionFolder, 'summary.md');
            await writeFile(summaryFile, summary);
            console.log(`[SUMMARY] Summary saved: ${path.relative(__dirname, summaryFile)}`);
            
            // Sync to Notion if page ID was provided
            if (recordingSession.notionPageId) {
              try {
                const notionSuccess = await syncToNotion(summary, recordingSession.notionPageId);
                if (notionSuccess) {
                  console.log(`[NOTION] Successfully synced summary to Notion page: ${recordingSession.notionPageId}`);
                } else {
                  console.log(`[NOTION] Failed to sync summary to Notion page: ${recordingSession.notionPageId}`);
                }
              } catch (notionError) {
                console.error(`[NOTION] Error syncing to Notion:`, notionError);
              }
            }
          }
        } catch (summaryError) {
          console.error(`[SUMMARY] Error generating summary:`, summaryError);
        }
      }
    } catch (error) {
      console.error(`[SESSION] Error saving final session:`, error);
    }
    
    recordingSession = null;
  }
});

client.login(process.env.DISCORD_TOKEN);