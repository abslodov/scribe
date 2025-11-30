```text
oracle-ear/
├── src/
│   └── index.ts       # The "Ironclad" logic
├── Dockerfile         # Debian-based build (required for Opus/Sodium)
├── package.json       # Dependencies including raw gRPC
├── tsconfig.json      # Strict Typescript config
├── .gitignore         # Safety first
└── README.md          # The manual on *why* this is built this way
```

# Oracle Ear - Discord Chirp 3 Transcriber

A production-grade Discord Bot that uses **Google Cloud Speech-to-Text V2 (Chirp 3)** to live-transcribe voice channels into Firestore.

## ⚠️ The Architecture (Why is this complex?)
This bot uses a **Raw gRPC** implementation (`@grpc/grpc-js`) instead of the standard Google Node.js library.

**Why?**
When running on Google Cloud Run, the standard library engages "DirectPath" routing which forcibly redirects all traffic to the global `speech.googleapis.com` endpoint. The Chirp 3 model, however, only exists in the `us` regional endpoint. The standard library ignores configuration overrides in this environment.

We utilize raw gRPC to verify the SSL credentials manually and force a connection to `us-speech.googleapis.com`, bypassing the library's internal routing logic.

## Prerequisites
1.  **Google Cloud Project** with billing enabled.
2.  **Speech-to-Text API (V2)** enabled.
3.  **Firebase Firestore** database created (Native mode).
4.  **Discord Bot Token** with "Message Content" and "Server Members" intent.

## Deployment (Cloud Run)

This bot requires **CPU always allocated** because Discord voice relies on a persistent UDP connection. If you use standard "CPU only during requests", the bot will hang immediately after joining.

### 1. Build
```bash
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/oracle-ear

gcloud run deploy oracle-ear \
  --image gcr.io/YOUR_PROJECT_ID/oracle-ear \
  --project YOUR_PROJECT_ID \
  --region us-central1 \
  --no-cpu-throttling \
  --min-instances 1 \
  --port 8080 \
  --set-env-vars DISCORD_TOKEN="YOUR_TOKEN",GOOGLE_CLOUD_PROJECT="YOUR_PROJECT_ID"

DISCORD_TOKEN: Your bot token.

GOOGLE_CLOUD_PROJECT: Your Project ID.

GOOGLE_CREDENTIALS_BASE64: (Optional) Only needed if not running on GCP infrastructure.
