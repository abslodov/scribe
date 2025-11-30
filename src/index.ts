import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, GuildMember } from 'discord.js';
import { joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, getVoiceConnection, VoiceConnection } from '@discordjs/voice';
import * as prism from 'prism-media';
import { Transform } from 'stream';
import * as admin from 'firebase-admin';
import * as http from 'http';
import * as sodium from 'libsodium-wrappers';
import { config as loadEnv } from 'dotenv';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { GoogleAuth } from 'google-auth-library';
import * as path from 'path';

loadEnv();

// --- CONFIGURATION ---
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;
const LOCATION = 'us'; 
const HOST = 'us-speech.googleapis.com:443'; 
const RECOGNIZER_ID = `projects/${PROJECT_ID}/locations/${LOCATION}/recognizers/_`;

if (!PROJECT_ID) { console.error("❌ GOOGLE_CLOUD_PROJECT env var missing"); process.exit(1); }

console.log('⛓️  IRONCLAD CONFIGURATION ACTIVE');
console.log(`   TARGET:       ${HOST}`);
console.log(`   PROJECT_ID:   ${PROJECT_ID}`);

// --- FIREBASE INIT ---
let db: admin.firestore.Firestore;
try {
  if (!admin.apps.length) admin.initializeApp();
  db = admin.firestore();
  console.log('🔥 Firestore initialized.');
} catch (e) {
  console.error('❌ Firestore init failed:', e);
  process.exit(1);
}

// --- LOAD GOOGLE PROTO ---
const speechPackage = require.resolve('@google-cloud/speech');
const protoPath = path.join(path.dirname(speechPackage), '../protos/google/cloud/speech/v2/cloud_speech.proto');
const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
    includeDirs: [ path.join(path.dirname(require.resolve('google-gax')), '../protos'), path.dirname(protoPath) ]
});
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
const SpeechService = protoDescriptor.google.cloud.speech.v2.Speech;

// --- SILENCE INJECTOR (With Chunking) ---
class SilenceInjector extends Transform {
  private lastTime = Date.now();
  private keepAliveInterval: NodeJS.Timeout;

  constructor() {
    super();
    this.keepAliveInterval = setInterval(() => {
      const now = Date.now();
      const delta = now - this.lastTime;
      if (delta > 100) {
        const bytesNeeded = Math.floor(delta * 192); // 48kHz * 2ch * 2bytes
        const maxChunk = 20000; // Cap at 20KB to prevent Google buffer overflow
        let sent = 0;
        while (sent < bytesNeeded) {
            const size = Math.min(bytesNeeded - sent, maxChunk);
            this.push(Buffer.alloc(size));
            sent += size;
        }
        this.lastTime = now;
      }
    }, 50);
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.lastTime = Date.now();
    if (chunk.length > 25600) {
         const max = 25600;
         for (let i = 0; i < chunk.length; i += max) this.push(chunk.subarray(i, i + max));
    } else {
         this.push(chunk);
    }
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    clearInterval(this.keepAliveInterval);
    callback(error || undefined);
  }
}

// --- CLIENTS ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
});

// --- HELPERS ---
const activeGuildSessions = new Map<string, string>();
const activeStreams = new Set<string>();

async function createSession(guildId: string, channelId: string, channelName: string): Promise<string> {
  const sessionRef = db.collection('guilds').doc(guildId).collection('sessions').doc();
  await sessionRef.set({
    start_time: admin.firestore.FieldValue.serverTimestamp(),
    status: 'active',
    channel_id: channelId,
    channel_name: channelName,
    region: LOCATION,
    model: 'chirp_3',
  });
  return sessionRef.id;
}

async function endSession(guildId: string) {
  const sessionId = activeGuildSessions.get(guildId);
  if (!sessionId) return;
  await db.collection('guilds').doc(guildId).collection('sessions').doc(sessionId).update({
    end_time: admin.firestore.FieldValue.serverTimestamp(),
    status: 'ended',
  });
  activeGuildSessions.delete(guildId);
}

async function getCombinedCreds() {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const authClient = await auth.getClient();
  const token = (await authClient.getAccessToken()).token;
  const sslCreds = grpc.credentials.createSsl();
  const callCreds = grpc.credentials.createFromMetadataGenerator((_args, callback) => {
    const metadata = new grpc.Metadata();
    if (token) metadata.add('authorization', `Bearer ${token}`);
    metadata.add('x-goog-user-project', PROJECT_ID);
    callback(null, metadata);
  });
  return grpc.credentials.combineChannelCredentials(sslCreds, callCreds);
}

async function performMicCheck(guildId: string): Promise<boolean> {
  return new Promise(async (resolve) => {
    const creds = await getCombinedCreds();
    const rawClient = new SpeechService(HOST, creds);
    const stream = rawClient.StreamingRecognize();
    let finished = false;
    let keepAlive: NodeJS.Timeout;

    const finish = (success: boolean) => {
        if (finished) return;
        finished = true;
        clearInterval(keepAlive);
        if (stream.writable) stream.end();
        resolve(success);
    };

    stream.on('error', (err: any) => { console.error("Mic Check Failed:", err); finish(false); });
    stream.on('data', () => { finish(true); });

    stream.write({
        recognizer: RECOGNIZER_ID,
        streaming_config: { 
            config: {
                explicit_decoding_config: { encoding: 'LINEAR16', sample_rate_hertz: 48000, audio_channel_count: 2 },
                language_codes: ['en-US'], 
                model: 'chirp_3'
            }
        }
    });

    keepAlive = setInterval(() => {
        if (finished) return;
        if (stream.writable) stream.write({ audio: Buffer.alloc(19200) });
    }, 100);

    setTimeout(() => { if (!finished) finish(true); }, 2000);
  });
}

async function startTranscriptionStream(connection: VoiceConnection, userId: string, username: string, guildId: string) {
  if (activeStreams.has(userId)) return;
  const sessionId = activeGuildSessions.get(guildId);
  if (!sessionId) return;

  activeStreams.add(userId);
  console.log(`🎙️  Starting stream: ${username}`);

  const opusStream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
  const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const silenceInjector = new SilenceInjector();

  const creds = await getCombinedCreds(); 
  const rawClient = new SpeechService(HOST, creds);
  const requestStream = rawClient.StreamingRecognize();

  requestStream.write({
    recognizer: RECOGNIZER_ID,
    streaming_config: { 
      config: {
        explicit_decoding_config: { encoding: 'LINEAR16', sample_rate_hertz: 48000, audio_channel_count: 2 },
        language_codes: ['en-US'], 
        model: 'chirp_3',
        features: { enable_voice_activity_events: true, enable_automatic_punctuation: true }
      }
    }
  });

  opusStream.pipe(opusDecoder).pipe(silenceInjector).on('data', (chunk: Buffer) => {
      if (requestStream.writable) requestStream.write({ audio: chunk });
  });

  requestStream.on('data', (response: any) => {
    const result = response.results?.[0];
    if (!result) return;
    const transcript = result.alternatives?.[0]?.transcript;
    if (transcript) {
      console.log(`👂 ${username}: ${transcript}`);
      if (result.is_final) {
        db.collection(`guilds/${guildId}/sessions/${sessionId}/transcripts`).add({
            text: transcript, speaker: username, speaker_id: userId,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(e => console.error(e));
      }
    }
  });

  const cleanup = () => {
    activeStreams.delete(userId);
    if (requestStream.writable) requestStream.end();
    silenceInjector.destroy();
  };
  opusStream.on('close', cleanup);
  opusDecoder.on('error', cleanup);
}

// --- DISCORD EVENTS ---
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Ready! Logged in as ${c.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);
  await rest.put(Routes.applicationCommands(c.user.id), { body: [
    new SlashCommandBuilder().setName('listen').setDescription('Start transcription').toJSON(),
    new SlashCommandBuilder().setName('leave').setDescription('Stop transcription').toJSON(),
  ]});
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guildId } = interaction;
  if (!guildId) return;

  if (commandName === 'listen') {
    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice?.channel;
    if (!voiceChannel) { await interaction.reply('Join a voice channel first.'); return; }

    await interaction.deferReply();
    await sodium.ready;

    if (!(await performMicCheck(guildId))) { await interaction.editReply("❌ API Error"); return; }
    
    activeGuildSessions.set(guildId, await createSession(guildId, voiceChannel.id, voiceChannel.name));
    
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id, guildId, adapterCreator: interaction.guild!.voiceAdapterCreator, selfDeaf: false,
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      interaction.editReply(`**Listening**\nSession: \`${activeGuildSessions.get(guildId)}\``);
      const subscribe = (id: string) => {
        const u = interaction.guild?.members.cache.get(id);
        if (u && !u.user.bot) startTranscriptionStream(connection, id, u.user.username, guildId);
      };
      voiceChannel.members.forEach(m => subscribe(m.id));
      connection.receiver.speaking.on('start', subscribe);
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => endSession(guildId));
  }

  if (commandName === 'leave') {
    getVoiceConnection(guildId)?.destroy();
    await endSession(guildId);
    await interaction.reply('Left channel.');
  }
});

const port = process.env.PORT || 8080;
const server = http.createServer((_, res) => { res.writeHead(200); res.end('OK'); });
server.listen(Number(port), '0.0.0.0', () => client.login(process.env.DISCORD_TOKEN));
