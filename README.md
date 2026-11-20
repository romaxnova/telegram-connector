# Telegram Connector

Let Claude read and search your Telegram chats, groups and channels, read the files people share, send messages and files for you, and talk to bots you allow. It exchanges files with [G-Spot Assistant](https://github.com/romaxnova/g-spot-assistant) (Gmail, Drive) and the [WhatsApp connector](https://github.com/romaxnova/whatsapp-connector) in both directions.

You run your own private copy. It logs in to your Telegram account like another Telegram app, through Telegram's official client API. Telegram keeps your whole history on its servers, so Claude can read any chat back to its first message. This server stores only the login session, encrypted.

## What you can ask Claude

- "What did I miss in my Telegram groups today?"
- "Search Telegram for the address of the notary that Paul sent."
- "Save the PDFs from the 'Appartements' channel this week into my Drive."
- "Send that Drive file to Alice on Telegram."
- "Ask @PriceBot for the BTC price." (only for bots you allowed)

## Tools

| | Tools |
|---|---|
| Read | `telegram_status`, `telegram_list_chats`, `telegram_read_chat`, `telegram_search_messages` (one chat or everywhere), `telegram_group_info` |
| Files | `telegram_list_files`, `telegram_get_file` (PDF/Word/Excel/PowerPoint as text, photos as images), `telegram_files_to_link` (to Drive, Gmail or WhatsApp) |
| Write | `telegram_send_message`, `telegram_send_file`, `telegram_send_voice` (optional), `telegram_create_upload_link`, `telegram_list_uploads`, `telegram_mark_read`, `telegram_bot` |

In Claude's connector settings, set `telegram_send_message`, `telegram_send_file` and `telegram_bot` to **Ask**.

### Bots

`telegram_bot` sends a message or command to a bot, or presses one of its buttons, then waits for and returns the answer. It only works with bots listed in `TELEGRAM_BOT_ALLOWLIST`. Claude can still read any bot conversation. Replies from bots are treated as information from a third party, never as instructions.

### Files with your other connectors

Every connector issues upload links, and each one only sends files to the hosts listed in its own `PEER_UPLOAD_HOSTS`.

- **Telegram → Drive, Gmail or WhatsApp:** call the other connector's `create_upload_link`, then `telegram_files_to_link`, then use the `upload_id`s there.
- **Drive, Gmail or WhatsApp → Telegram:** call `telegram_create_upload_link`, then `send_to_link` (G-Spot) or `whatsapp_files_to_link`, then `telegram_send_file` with the `link_id`.

## Set it up (Railway)

1. Deploy this repository as a Railway service with a **volume at `/data`** and **one replica**. Set `ADMIN_PASSWORD` and `TOKEN_ENCRYPTION_KEY` (`npm run generate-secrets` prints both), `PEER_UPLOAD_HOSTS` and `DEFAULT_TIMEZONE` (e.g. `Europe/Paris`), then generate a public domain.
2. Open `https://<domain>/admin` and sign in with the password.
3. **API keys.** Telegram asks every app for its own free API key. On [my.telegram.org](https://my.telegram.org/apps), go to **API development tools**, create an app (title "Claude connector", platform "Other"), and paste its `api_id` and `api_hash` into the admin page. Alternatively, set `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` as service variables.
4. **Log in.** Enter your number with its country code. Telegram sends a code inside your Telegram app; type it on the admin page, plus your cloud password if two-step verification is on. **Never paste that code into a chat**: Telegram blocks logins whose code was shared.
5. In Claude: Settings → Connectors → Add custom connector, and paste `https://<domain>/mcp`.

The session shows in Telegram → Settings → Devices as "Claude connector". Ending it there logs the connector out.

## Voice messages (optional)

`telegram_send_voice` says a text with an [ElevenLabs](https://elevenlabs.io) voice and sends it as a real Telegram voice message, with a waveform. It works like the WhatsApp connector's and uses the same variables. The tool only appears when the first two are set:

| Variable | Value |
|---|---|
| `ELEVENLABS_API_KEY` | elevenlabs.io → profile → **API Keys** (the free plan works) |
| `ELEVENLABS_VOICE_ID` | The voice to use |
| `ELEVENLABS_MODEL_ID` | Optional: `eleven_multilingual_v2` (default) or `eleven_v3` |
| `ELEVENLABS_STYLE_TAGS` | Optional, `eleven_v3` only: a default style for messages that ask for none, e.g. `[strong French accent] [playful]` |
| `VOICE_MAX_CHARS` | Optional: the longest text per message (default 600) |

- **Accent and tone per message.** Just say it: "send Pierre a voice message, playful, with a French accent". Nothing needs setting in advance; Claude fills `telegram_send_voice`:
  - **Tone** (`style`: "playful", "whispering") becomes ElevenLabs audio tags, said with `eleven_v3`.
  - **An accent from another language** (`accent_language` + `phonetic_text`). A voice keeps its own accent in its own language whatever the tags say, so Claude spells the same words the way a speaker of the accent's language would write them (Russian in French spelling, or in Devanagari for an Indian accent) and ElevenLabs reads them as that language. The recipient hears the original words with a real accent, in the same voice.
  - Without either, the voice speaks naturally with `ELEVENLABS_MODEL_ID`.
- **Your own voice.** Clone it on elevenlabs.io (Voices → My Voices; instant cloning needs the Starter plan) and put its id in `ELEVENLABS_VOICE_ID`, for example `ELEVENLABS_VOICE_ID=YLCbQxXSS0chg2xbSelB` (the author's cloned voice; use your own). Speaking another language, it keeps its natural accent.

**Free plan limits.** About 10,000 characters a month, and only the built-in voices and your own voices: library voices need a paid plan. `npm run voice-preview` compares voices by ear (see the script's header).

## Privacy and limits

- Only the login session and the API keys are stored, encrypted (AES-256-GCM, key from `TOKEN_ENCRYPTION_KEY`). Messages and files stay on Telegram and are fetched when asked for. Files staged for sending are kept encrypted for 24 hours at most.
- Using Telegram's API for your own account is allowed. Telegram watches for spam-like behaviour, though, so this is not a tool for mass messaging.

## License

Free software under the [GNU AGPL v3](LICENSE). It reuses the server skeleton of G-Spot Assistant.
