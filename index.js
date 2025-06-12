// index.js
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { createWriteStream, createReadStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Prism from 'prism-media';
import axios from 'axios';
import dotenv from 'dotenv';
import { Dropbox } from 'dropbox';

dotenv.config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let recordingStreams = new Map();
let outputStream = null;
let currentConnection = null;
let audioChunks = [];
let currentOutputPath = null;
let isRecording = false;
let startTime = null;
let currentChannelName = null;

// WAV header constants
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;

// Add participant tracking
let currentParticipants = new Set();

const DROPBOX_ACCESS_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;
const dbx = new Dropbox({ accessToken: DROPBOX_ACCESS_TOKEN });

async function uploadToDropbox(filePath) {
    const fileName = path.basename(filePath);
    const fileContents = await new Promise((resolve, reject) => {
        const chunks = [];
        const stream = createReadStream(filePath);
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
    const dropboxPath = `/${fileName}`;
    await dbx.filesUpload({
        path: dropboxPath,
        contents: fileContents,
        mode: 'overwrite',
        autorename: false,
        mute: true,
    });
    // Try to create a shared link, or fetch it if it already exists
    let sharedLink;
    try {
        const res = await dbx.sharingCreateSharedLinkWithSettings({ path: dropboxPath });
        sharedLink = res.result.url;
    } catch (e) {
        if (
            (e.error && e.error.error_shared_link_already_exists) ||
            (e.error && e.error['.tag'] === 'shared_link_already_exists')
        ) {
            const res = await dbx.sharingListSharedLinks({ path: dropboxPath, direct_only: true });
            if (res.result.links.length > 0) {
                sharedLink = res.result.links[0].url;
            } else {
                throw new Error('Shared link already exists but could not be retrieved.');
            }
        } else {
            throw e;
        }
    }
    // Convert to direct download link (dl.dropboxusercontent.com)
    let directLink = sharedLink.replace('www.dropbox.com', 'dl.dropboxusercontent.com');
    // Remove ?dl=0, ?dl=1, or ?raw=1 but keep other query params (like rlkey)
    directLink = directLink.replace(/\?(dl|raw)=\d?/, '');
    return directLink;
}

async function uploadToFireflies(filePath) {
    try {
        // First upload to Dropbox
        const fileUrl = await uploadToDropbox(filePath);
        
        const url = "https://api.fireflies.ai/graphql";
        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.FIREFLIES_API_KEY}`,
        };

        // Convert participants to Fireflies format
        const attendees = Array.from(currentParticipants).map(member => ({
            displayName: member.displayName || member.user.username,
            email: `${member.user.username.toLowerCase()}@discord.user`  // Placeholder email
        }));

        const input = {
            url: fileUrl,
            title: path.basename(filePath, '.wav'),
            attendees: attendees
        };

        console.log('Sending to Fireflies with input:', JSON.stringify(input, null, 2));

        const data = {
            query: `       
            mutation($input: AudioUploadInput) {
                uploadAudio(input: $input) {
                    success
                    title
                    message
                }
            }`,
            variables: { input }
        };

        console.log('Sending GraphQL request to Fireflies...');
        const response = await axios.post(url, data, { headers });
        console.log('Fireflies response:', JSON.stringify(response.data, null, 2));
        
        if (!response.data.data.uploadAudio.success) {
            throw new Error(`Fireflies API error: ${response.data.data.uploadAudio.message}`);
        }

        return response.data.data.uploadAudio;
    } catch (error) {
        console.error('Error uploading to Fireflies:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
            console.error('Response status:', error.response.status);
        }
        throw error;
    }
}

function createWavHeader(dataSize) {
    const buffer = Buffer.alloc(44);
    
    // RIFF identifier
    buffer.write('RIFF', 0);
    // File length minus RIFF identifier length and file description length
    buffer.writeUInt32LE(36 + dataSize, 4);
    // RIFF type
    buffer.write('WAVE', 8);
    // Format chunk identifier
    buffer.write('fmt ', 12);
    // Format chunk length
    buffer.writeUInt32LE(16, 16);
    // Sample format (raw)
    buffer.writeUInt16LE(1, 20);
    // Channel count
    buffer.writeUInt16LE(CHANNELS, 22);
    // Sample rate
    buffer.writeUInt32LE(SAMPLE_RATE, 24);
    // Byte rate (sample rate * block align)
    buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8), 28);
    // Block align (channel count * bytes per sample)
    buffer.writeUInt16LE(CHANNELS * (BITS_PER_SAMPLE / 8), 32);
    // Bits per sample
    buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
    // Data chunk identifier
    buffer.write('data', 36);
    // Data chunk length
    buffer.writeUInt32LE(dataSize, 40);
    
    return buffer;
}

async function saveWavFile() {
    if (!currentOutputPath) return;

    // Sort chunks by timestamp
    audioChunks.sort((a, b) => a.timestamp - b.timestamp);

    // Combine all chunks in chronological order
    let allPcmData = Buffer.alloc(0);
    for (const chunk of audioChunks) {
        allPcmData = Buffer.concat([allPcmData, chunk.data]);
    }
    
    if (allPcmData.length === 0) return;

    // Create WAV header
    const wavHeader = createWavHeader(allPcmData.length);
    
    // Write WAV file
    const fileStream = createWriteStream(currentOutputPath);
    fileStream.write(wavHeader);
    fileStream.write(allPcmData);
    fileStream.end();

    // Wait for the file to be written
    await new Promise((resolve, reject) => {
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
    });

    // Upload to Fireflies.ai
    try {
        const uploadResult = await uploadToFireflies(currentOutputPath);
        console.log('Uploaded to Fireflies:', uploadResult);
        return uploadResult;
    } catch (error) {
        console.error('Failed to upload to Fireflies:', error);
        throw error;
    }

    // Clear the chunks
    audioChunks = [];
    currentOutputPath = null;
    isRecording = false;
    startTime = null;
}

// Define slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('record')
        .setDescription('Start recording audio from the current voice channel'),
    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop the current recording'),
].map(command => command.toJSON());

// Register slash commands
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();

client.once('ready', () => {
    console.log('Bot is ready!');
});

client.on('interactionCreate', async interaction => {
    try {
        if (!interaction.isCommand()) return;
        
        console.log('Command received:', interaction.commandName);
        console.log('Guild ID:', interaction.guildId);
        console.log('Channel ID:', interaction.channelId);
        console.log('User ID:', interaction.user.id);

        const { commandName } = interaction;

        if (commandName === 'record') {
            if (isRecording) {
                return interaction.reply({
                    content: 'Already recording! Use /stop to stop the current recording.',
                    ephemeral: true
                });
            }

            const member = interaction.member;
            
            console.log('Member voice channel:', member.voice.channel?.id);
            
            if (!member.voice.channel) {
                return interaction.reply({
                    content: 'You need to be in a voice channel to use this command!',
                    ephemeral: true
                });
            }

            currentConnection = joinVoiceChannel({
                channelId: member.voice.channel.id,
                guildId: interaction.guildId,
                adapterCreator: interaction.guild.voiceAdapterCreator,
            });

            const channel = member.voice.channel;
            if (!channel) {
                await interaction.reply({ content: 'You must be in a voice channel to use this command.', ephemeral: true });
                return;
            }
            // Store the channel name for file naming
            currentChannelName = channel.name.replace(/[^a-zA-Z0-9-_]/g, '_'); // sanitize for filesystem
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            currentOutputPath = path.join(__dirname, `${currentChannelName}-${timestamp}.wav`);
            
            // Reset audio chunks array
            audioChunks = [];
            startTime = Date.now();
            
            const receiver = currentConnection.receiver;
            const voiceChannel = member.voice.channel;
            
            // Subscribe to all members in the voice channel
            for (const [memberId, member] of voiceChannel.members) {
                if (!member.user.bot) {  // Don't record bot audio
                    const stream = receiver.subscribe(memberId, { 
                        end: { behavior: 'manual' }
                    });
                    
                    const decoder = new Prism.opus.Decoder({ 
                        frameSize: 960, 
                        channels: CHANNELS, 
                        rate: SAMPLE_RATE 
                    });
                    
                    stream
                        .pipe(decoder)
                        .on('data', chunk => {
                            if (isRecording) {
                                audioChunks.push({
                                    timestamp: Date.now() - startTime,
                                    data: chunk
                                });
                            }
                        });
                    
                    recordingStreams.set(memberId, stream);
                }
            }

            // Set recording flag after all streams are set up
            isRecording = true;

            await interaction.reply({
                content: 'Started recording all users in the voice channel! Use /stop to stop recording.',
                ephemeral: true
            });

            currentConnection.on(VoiceConnectionStatus.Disconnected, async () => {
                try {
                    await Promise.race([
                        entersState(currentConnection, VoiceConnectionStatus.Signalling, 5_000),
                        entersState(currentConnection, VoiceConnectionStatus.Connecting, 5_000),
                    ]);
                } catch (error) {
                    currentConnection.destroy();
                }
            });
        }

        if (commandName === 'stop') {
            if (!isRecording) {
                return interaction.reply({
                    content: 'No recording in progress!',
                    ephemeral: true
                });
            }

            // Defer the reply since the upload might take some time
            await interaction.deferReply();

            // Stop all recording streams
            for (const [memberId, stream] of recordingStreams) {
                stream.destroy();
            }
            recordingStreams.clear();

            try {
                // Save the WAV file and upload to Fireflies
                const uploadResult = await saveWavFile();
                
                await interaction.editReply({
                    content: `Recording stopped! The file has been saved and uploaded to Fireflies.ai.`,
                    ephemeral: true
                });
            } catch (error) {
                console.error('Failed to upload to Fireflies:', error);
                await interaction.editReply({
                    content: 'Recording stopped, but there was an error uploading to Fireflies.ai. The file has been saved locally.',
                    ephemeral: true
                });
            }

            if (currentConnection) {
                currentConnection.destroy();
                currentConnection = null;
            }
        }
    } catch (error) {
        console.error('Error handling interaction:', error);
        await interaction.reply({
            content: 'An error occurred while processing your command.',
            ephemeral: true
        });
    }
});

client.on('voiceStateUpdate', (oldState, newState) => {
    // Ignore if the state change is not in our recording channel
    if (!currentConnection || oldState.channelId !== currentConnection.joinConfig.channelId && newState.channelId !== currentConnection.joinConfig.channelId) {
        return;
    }

    // User joined the channel
    if (!oldState.channelId && newState.channelId) {
        if (!newState.member.user.bot) {  // Don't add bots
            currentParticipants.add(newState.member);
            console.log(`${newState.member.user.username} joined the voice channel`);
        }
    }
    // User left the channel
    else if (oldState.channelId && !newState.channelId) {
        if (!oldState.member.user.bot) {  // Don't remove bots
            currentParticipants.delete(oldState.member);
            console.log(`${oldState.member.user.username} left the voice channel`);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);

